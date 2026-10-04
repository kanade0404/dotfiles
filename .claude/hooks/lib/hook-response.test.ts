import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseHookClient, shouldEmitAllow } from "./hook-response.ts";
import { createGitFixture, envWithoutGit, type GitFixture } from "./git-fixture.ts";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const analyzer = resolve(import.meta.dir, "..", "pre-tool-use-bash-analyzer.ts");

describe("parseHookClient", () => {
  test("--client=claude-code を渡すと claude-code", () => {
    expect(parseHookClient(["bun", analyzer, "--client=claude-code"])).toBe("claude-code");
  });

  // Codex は bare な permissionDecision:"allow" を unsupported として hook 失敗扱いにする。
  // 引数が無い / 不明な場合は allow を出さない側 (codex) に倒す。
  test("引数無しは codex", () => {
    expect(parseHookClient(["bun", analyzer])).toBe("codex");
  });

  test("未知の値は codex", () => {
    expect(parseHookClient(["bun", analyzer, "--client=other"])).toBe("codex");
  });
});

describe("shouldEmitAllow", () => {
  const approved = { decision: "allow", hookApproved: true } as const;

  test("claude-code かつ hookApproved かつ permission_mode が default なら true", () => {
    expect(shouldEmitAllow(approved, "claude-code", "default")).toBe(true);
  });

  test("codex では hookApproved でも false", () => {
    expect(shouldEmitAllow(approved, "codex", "default")).toBe(false);
  });

  test("hookApproved でない allow (pass-through) は false", () => {
    expect(shouldEmitAllow({ decision: "allow", hookApproved: false }, "claude-code", "default")).toBe(false);
  });

  test("ask / deny は false", () => {
    expect(shouldEmitAllow({ decision: "ask", reason: "x" }, "claude-code", "default")).toBe(false);
    expect(
      shouldEmitAllow({ decision: "deny", denyReasons: [{ command: "x", pattern: "y" }] }, "claude-code", "default"),
    ).toBe(false);
  });

  // hook allow は本体の確認と auto mode の classifier をスキップさせる。本体が allow ルールで
  // 自動許可し、それ以外を確認に回すモード (default / acceptEdits) に限る
  test("permission_mode が acceptEdits なら true", () => {
    expect(shouldEmitAllow(approved, "claude-code", "acceptEdits")).toBe(true);
  });

  test.each([
    // plan は auto mode が使える環境では既定 (useAutoModeDuringPlan) で shell コマンドを classifier に回す
    ["plan", "plan"],
    ["auto", "auto"],
    ["dontAsk", "dontAsk"],
    ["bypassPermissions", "bypassPermissions"],
    ["未知の値", "manual"],
    ["大小文字違い", "Default"],
    ["欠落", undefined],
    ["null", null],
    ["文字列でない", 1],
  ] as const)("permission_mode が %s なら false", (_, mode) => {
    expect(shouldEmitAllow(approved, "claude-code", mode)).toBe(false);
  });
});

// hook 本体をプロセスとして起動し、引数・cwd による出力の分岐を確認する。
// HOME は一時ディレクトリにして個人の ~/.claude/settings.json の影響を排除し、
// リポジトリ同梱の .claude/settings.json の permissions (+ extraAsk) をそこに置く。
// cwd (hook 入力 JSON の cwd) は一時リポジトリ main。GIT_* は環境から除く。
// CLAUDE_PROJECT_DIR (Claude Code が hook に渡すプロジェクトルート) は既定で main。
// 入力 JSON の permission_mode は既定で "default"。
// allow を渡すとユーザ設定の permissions.allow をそれで置き換える。
function setupHookEnv(opts: { extraAsk?: readonly string[]; allow?: readonly string[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "hook-response-test-"));
  const settings = JSON.parse(readFileSync(resolve(repoRoot, ".claude", "settings.json"), "utf8")) as {
    permissions: { allow?: readonly string[]; ask?: string[] };
  };
  settings.permissions.ask = [...(settings.permissions.ask ?? []), ...(opts.extraAsk ?? [])];
  if (opts.allow !== undefined) settings.permissions.allow = opts.allow;
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: settings.permissions }));
  const fx = createGitFixture();

  /**
   * extraEnv の値が undefined のキーは環境から取り除く。テストを実行している環境の
   * CLAUDE_CONFIG_DIR は引き継がない。hook プロセスの作業ディレクトリは一時の HOME
   * (HOME を空にしたとき bun がキャッシュを作業ディレクトリに作るため、リポジトリを汚さない)。
   * inputFields は入力 JSON に足すフィールド (既定は permission_mode: "default")。
   */
  function runHook(
    command: string,
    args: readonly string[],
    cwd: string = fx.main,
    extraEnv: Record<string, string | undefined> = { CLAUDE_PROJECT_DIR: fx.main },
    inputFields: Record<string, unknown> = { permission_mode: "default" },
  ) {
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      cwd,
      ...inputFields,
    });
    const env: Record<string, string> = envWithoutGit({ HOME: home });
    delete env.CLAUDE_CONFIG_DIR;
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const r = spawnSync("bun", [analyzer, ...args], { input, encoding: "utf8", env, cwd: home });
    return { status: r.status, stdout: r.stdout };
  }

  /** hook が出した permissionDecision。無出力 (pass-through) は null */
  function decisionOf(
    command: string,
    cwd?: string,
    extraEnv?: Record<string, string | undefined>,
    inputFields?: Record<string, unknown>,
  ): string | null {
    const r = runHook(command, ["--client=claude-code"], cwd, extraEnv, inputFields);
    expect(r.status).toBe(0);
    return r.stdout === "" ? null : JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
  }

  return {
    fx,
    runHook,
    decisionOf,
    cleanup: () => {
      fx.cleanup();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe("pre-tool-use-bash-analyzer (プロセス)", () => {
  let env: ReturnType<typeof setupHookEnv>;
  beforeAll(() => { env = setupHookEnv(); });
  afterAll(() => { env.cleanup(); });

  test("Claude Code: git -C . status は permissionDecision allow を返す", () => {
    const r = env.runHook("git -C . status", ["--client=claude-code"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("Codex (引数無し): git -C . status は何も出力しない", () => {
    const r = env.runHook("git -C . status", []);
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: "" });
  });

  test("Claude Code: -C を含まない git status は従来どおり何も出力しない", () => {
    const r = env.runHook("git status", ["--client=claude-code"]);
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: "" });
  });

  test("Claude Code: git -C /repo reset --hard は deny", () => {
    const r = env.runHook("git -C /repo reset --hard", ["--client=claude-code"]);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  // hook が allow を返すのは、生コマンド全体が単一の単純な `git ... -C <dir> ... <sub> ...`
  // の文法 (evaluator.ts の isPlainGitCCommand) に一致し、<dir> が cwd と同じリポジトリの場合だけ。
  test.each([
    "git -C sub status",
    "git -C sub log --oneline -5",
    "git -C 'r x' log --oneline",
    "git --no-pager -C sub log",
    'git -C sub commit -m "fix bug"',
    "git -C sub diff --stat",
    "git -C sub log --format=%H",
    "git -C ../wt status",
  ])("Claude Code: %j は allow を返す", (command) => {
    expect(env.decisionOf(command)).toBe("allow");
  });

  test("Claude Code: worktree を cwd にした main への git -C は allow を返す", () => {
    expect(env.decisionOf(`git -C ${env.fx.main} status`, env.fx.worktree)).toBe("allow");
  });

  // 実行シェル (zsh) で git 以外のコマンドが実行される・git の実行内容が変わる・
  // ファイルに書き込む形と、複合コマンド。hook は allow を出さない
  // (無出力で本体の判定に委ねる / ask / deny のいずれか)。
  test.each([
    "echo () (touch X); git -C sub status; echo",
    "git -C sub status; sleep () (touch X); sleep 0",
    "git -C sub status; echo () touch X; echo",
    "git -C sub status =(touch X)",
    "git -C sub status; echo =(touch X)",
    "time GIT_TRACE=X git -C sub status",
    "time PATH=/tmp/evil git -C sub status",
    "time env GIT_TRACE=X git -C sub status",
    "git -C sub log -1 >&1mk",
    "git -C sub log -1 2>&1 >&2zz",
    "git -C sub status #'\ntouch /tmp/pwned",
    "git -C sub status #'\npython3 -c 'import os'\n#'",
    "git -C sub status #'\nrm -rf /tmp/x\n#'",
    "git -C sub log $'\\'' ; touch /tmp/pwned #'",
    'git -C sub commit -m "fix #12"',
    "./git -C . status",
    "/tmp/evil/git -C sub status",
    "git -C sub status; /tmp/evil/echo hi",
    "git -C sub status && git -C sub diff",
    "(git -C sub status)",
    "git -C =x status",
    "git -C ~/x status",
    "time git -C sub status",
    "command git -C sub status",
  ])("Claude Code: %j は allow を返さない", (command) => {
    expect(env.decisionOf(command)).not.toBe("allow");
  });

  // -C の対象が cwd と別の git common dir を持つ (そのリポジトリの .git/config や
  // .git/hooks で任意コマンドを実行されうる) 場合は allow せず pass-through にする。
  test.each([
    ["無関係なリポジトリ", (f: GitFixture) => `git -C ${f.other} status`],
    ["submodule 相当", () => "git -C sm status"],
    ["main 内の別リポジトリ", () => "git -C nested status"],
    ["存在しないパス", () => "git -C no-such-dir status"],
    ["別リポジトリへのシンボリックリンク", () => "git -C link-other status"],
    // git worktree add で作られていない gitdir (common dir が同じでも)
    ["手で作った gitdir", () => "git -C crafted status"],
    ["gitdir が worktrees/<name> 配下でない", () => "git -C notwt status"],
    ["逆リンクが一致しない gitdir", () => "git -C hijack status"],
  ] as const)("Claude Code: -C の対象が %s なら何も出力しない", (_, command) => {
    expect(env.decisionOf(command(env.fx))).toBeNull();
  });

  test("Claude Code: worktreeConfig 有効なリポジトリの正規の worktree への git -C は allow を返す", () => {
    expect(env.decisionOf(`git -C ${join(env.fx.base, "wtc-sparse")} status`, env.fx.worktreeConfig, { CLAUDE_PROJECT_DIR: env.fx.worktreeConfig })).toBe("allow");
  });

  test("Claude Code: worktreeConfig 有効なリポジトリで手で作った gitdir (config.worktree に fsmonitor) への git -C は何も出力しない", () => {
    expect(env.decisionOf("git -C crafted status", env.fx.worktreeConfig, { CLAUDE_PROJECT_DIR: env.fx.worktreeConfig })).toBeNull();
  });

  test("Claude Code: cwd が git 管理外なら何も出力しない", () => {
    expect(env.decisionOf(`git -C ${env.fx.main} status`, env.fx.plain)).toBeNull();
  });
});

// ~/.claude/settings.json の ask ルールは本体ではプレフィックス一致なので -C 版に効かない。
// hook は正規化した `git <sub> ...` に ask を allow より先に当て、ask を返す。
describe("pre-tool-use-bash-analyzer (プロセス): ~/.claude/settings.json の ask と git -C", () => {
  let env: ReturnType<typeof setupHookEnv>;
  beforeAll(() => { env = setupHookEnv({ extraAsk: ["Bash(git push *)", "Bash(git commit *)"] }); });
  afterAll(() => { env.cleanup(); });

  test.each(['git -C . commit -m "fix bug"', "git -C . push origin main"])(
    "%j は ask を返す",
    (command) => {
      expect(env.decisionOf(command)).toBe("ask");
    },
  );

  test("ask に一致しない git -C . status は allow のまま", () => {
    expect(env.decisionOf("git -C . status")).toBe("allow");
  });
});

// hook allow の根拠になる allow ルールは、本体が通常適用するユーザ設定
// (~/.claude/settings.json) 由来だけ (例外は ADR 0003 の既知の制約: --setting-sources /
// SDK の settingSources でユーザ設定を除いた構成)。リポジトリ内の .codex/* や cwd 基準の .claude/*、
// CLAUDE_PROJECT_DIR の .claude/settings*.json の allow では hook allow しない。
describe("pre-tool-use-bash-analyzer (プロセス): hook allow の根拠になる設定ファイル", () => {
  let env: ReturnType<typeof setupHookEnv>;
  beforeAll(() => { env = setupHookEnv(); });
  afterAll(() => { env.cleanup(); });
  afterEach(() => {
    for (const dir of [join(env.fx.main, ".codex"), join(env.fx.main, ".claude"), join(env.fx.main, "sub", ".claude")]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeSettings(path: string, permissions: Record<string, string[]>) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ permissions }));
  }

  test("リポジトリの .codex/settings.json の allow では allow を返さない", () => {
    writeSettings(join(env.fx.main, ".codex", "settings.json"), { allow: ["Bash(git submodule *)"] });
    expect(env.decisionOf("git -C . submodule foreach touch pwned")).not.toBe("allow");
  });

  test("cwd (サブディレクトリ) の .claude/settings.json の allow では allow を返さない", () => {
    writeSettings(join(env.fx.main, "sub", ".claude", "settings.json"), { allow: ["Bash(git submodule *)"] });
    expect(env.decisionOf("git -C . submodule foreach touch pwned", join(env.fx.main, "sub"))).not.toBe("allow");
  });

  // --setting-sources user や未信頼のワークスペースでは本体がプロジェクトの allow を適用しない
  test.each(["settings.json", "settings.local.json"])("CLAUDE_PROJECT_DIR の .claude/%s の allow では allow を返さない", (file) => {
    writeSettings(join(env.fx.main, ".claude", file), { allow: ["Bash(git submodule *)"] });
    expect(env.decisionOf("git -C . submodule foreach touch pwned")).toBeNull();
  });

  test("CLAUDE_PROJECT_DIR が無ければ ~/.claude/settings.json の allow でも allow を返さない", () => {
    expect(env.decisionOf("git -C . status", env.fx.main, {})).toBeNull();
  });

  test("前提: 既定の環境では git -C . status に allow を返す", () => {
    expect(env.decisionOf("git -C . status")).toBe("allow");
  });

  test("CLAUDE_CONFIG_DIR が環境にあれば (プロジェクトの allow があっても) allow を返さない", () => {
    writeSettings(join(env.fx.main, ".claude", "settings.json"), { allow: ["Bash(git status *)"] });
    expect(
      env.decisionOf("git -C . status", env.fx.main, { CLAUDE_PROJECT_DIR: env.fx.main, CLAUDE_CONFIG_DIR: "/nonexistent" }),
    ).toBeNull();
  });

  test.each([
    ["未設定", undefined],
    ["空文字列", ""],
  ] as const)("HOME が%sなら allow を返さない", (_, home) => {
    writeSettings(join(env.fx.main, ".claude", "settings.json"), { allow: ["Bash(git status *)"] });
    expect(env.decisionOf("git -C . status", env.fx.main, { CLAUDE_PROJECT_DIR: env.fx.main, HOME: home })).toBeNull();
  });

  test("worktree のセッションで main checkout の .claude/settings.local.json の deny は効く", () => {
    const worktreeSession = { CLAUDE_PROJECT_DIR: env.fx.worktree };
    expect(env.decisionOf("git -C . status", env.fx.worktree, worktreeSession)).toBe("allow");
    writeSettings(join(env.fx.main, ".claude", "settings.local.json"), { deny: ["Bash(git status *)"] });
    expect(env.decisionOf("git -C . status", env.fx.worktree, worktreeSession)).toBe("deny");
  });

  test("リポジトリの .codex/settings.json の deny は効く", () => {
    writeSettings(join(env.fx.main, ".codex", "settings.json"), { deny: ["Bash(git status *)"] });
    expect(env.decisionOf("git -C . status")).toBe("deny");
  });
});

// hook allow は本体の確認と auto mode の classifier をスキップさせるので、入力 JSON の
// permission_mode が default / acceptEdits のときだけ allow を返す
describe("pre-tool-use-bash-analyzer (プロセス): permission_mode", () => {
  let env: ReturnType<typeof setupHookEnv>;
  beforeAll(() => { env = setupHookEnv(); });
  afterAll(() => { env.cleanup(); });

  test.each(["default", "acceptEdits"])("%s なら git -C . status に allow を返す", (mode) => {
    expect(env.decisionOf("git -C . status", undefined, undefined, { permission_mode: mode })).toBe("allow");
  });

  test.each([
    ["plan", { permission_mode: "plan" }],
    ["auto", { permission_mode: "auto" }],
    ["dontAsk", { permission_mode: "dontAsk" }],
    ["bypassPermissions", { permission_mode: "bypassPermissions" }],
    ["未知の値", { permission_mode: "manual" }],
    ["大小文字違いの Default", { permission_mode: "Default" }],
    ["大小文字違いの AcceptEdits", { permission_mode: "AcceptEdits" }],
    ["null", { permission_mode: null }],
    ["数値", { permission_mode: 0 }],
    ["配列", { permission_mode: ["default"] }],
    ["欠落", {}],
  ] as const)("%s なら git -C . status に何も出力しない", (_, inputFields) => {
    expect(env.decisionOf("git -C . status", undefined, undefined, inputFields)).toBeNull();
  });

  test("auto でも deny は従来どおり返す", () => {
    expect(env.decisionOf("git -C . reset --hard", undefined, undefined, { permission_mode: "auto" })).toBe("deny");
  });
});

// 本体は auto mode で Bash(*) のような広い allow を落とす。hook allow の根拠は
// `git <リテラルのサブコマンド>` で始まる allow に限る
describe("pre-tool-use-bash-analyzer (プロセス): 広い allow", () => {
  test.each([["Bash(*)"], ["Bash(git *)"]])("~/.claude/settings.json の allow が %s だけなら allow を返さない", (pattern) => {
    const env = setupHookEnv({ allow: [pattern] });
    try {
      expect(env.decisionOf("git -C . submodule foreach touch pwned")).toBeNull();
      expect(env.decisionOf("git -C . status")).toBeNull();
    } finally {
      env.cleanup();
    }
  });
});

describe("hook の登録: Claude Code だけが --client=claude-code を渡す", () => {
  function preToolUseCommands(path: string): string[] {
    const json = JSON.parse(readFileSync(path, "utf8")) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    return json.hooks.PreToolUse.flatMap((h) => h.hooks.map((x) => x.command))
      .filter((c) => c.includes("pre-tool-use-bash-analyzer.ts"));
  }

  test(".claude/settings.json は --client=claude-code 付きで起動する", () => {
    expect(preToolUseCommands(resolve(repoRoot, ".claude", "settings.json"))).toEqual([
      "bun ~/.claude/hooks/pre-tool-use-bash-analyzer.ts --client=claude-code",
    ]);
  });

  test(".codex/hooks.json は --client を渡さない", () => {
    expect(preToolUseCommands(resolve(repoRoot, ".codex", "hooks.json"))).toEqual([
      "bun ~/.codex/hooks/pre-tool-use-bash-analyzer.ts",
    ]);
  });
});

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  test("claude-code かつ hookApproved なら true", () => {
    expect(shouldEmitAllow({ decision: "allow", hookApproved: true }, "claude-code")).toBe(true);
  });

  test("codex では hookApproved でも false", () => {
    expect(shouldEmitAllow({ decision: "allow", hookApproved: true }, "codex")).toBe(false);
  });

  test("hookApproved でない allow (pass-through) は false", () => {
    expect(shouldEmitAllow({ decision: "allow", hookApproved: false }, "claude-code")).toBe(false);
  });

  test("ask / deny は false", () => {
    expect(shouldEmitAllow({ decision: "ask", reason: "x" }, "claude-code")).toBe(false);
    expect(
      shouldEmitAllow({ decision: "deny", denyReasons: [{ command: "x", pattern: "y" }] }, "claude-code"),
    ).toBe(false);
  });
});

// hook 本体をプロセスとして起動し、引数・cwd による出力の分岐を確認する。
// HOME は一時ディレクトリにして個人の ~/.claude/settings.json の影響を排除し、
// リポジトリ同梱の .claude/settings.json の permissions (+ extraAsk) をそこに置く。
// cwd (hook 入力 JSON の cwd) は一時リポジトリ main。GIT_* は環境から除く。
function setupHookEnv(extraAsk: readonly string[] = []) {
  const home = mkdtempSync(join(tmpdir(), "hook-response-test-"));
  const settings = JSON.parse(readFileSync(resolve(repoRoot, ".claude", "settings.json"), "utf8")) as {
    permissions: { ask?: string[] };
  };
  settings.permissions.ask = [...(settings.permissions.ask ?? []), ...extraAsk];
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: settings.permissions }));
  const fx = createGitFixture();

  function runHook(command: string, args: readonly string[], cwd: string = fx.main) {
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      cwd,
    });
    const r = spawnSync("bun", [analyzer, ...args], {
      input,
      encoding: "utf8",
      env: envWithoutGit({ HOME: home }),
    });
    return { status: r.status, stdout: r.stdout };
  }

  /** hook が出した permissionDecision。無出力 (pass-through) は null */
  function decisionOf(command: string, cwd?: string): string | null {
    const r = runHook(command, ["--client=claude-code"], cwd);
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
  ] as const)("Claude Code: -C の対象が %s なら何も出力しない", (_, command) => {
    expect(env.decisionOf(command(env.fx))).toBeNull();
  });

  test("Claude Code: cwd が git 管理外なら何も出力しない", () => {
    expect(env.decisionOf(`git -C ${env.fx.main} status`, env.fx.plain)).toBeNull();
  });
});

// ~/.claude/settings.json の ask ルールは本体ではプレフィックス一致なので -C 版に効かない。
// hook は正規化した `git <sub> ...` に ask を allow より先に当て、ask を返す。
describe("pre-tool-use-bash-analyzer (プロセス): ~/.claude/settings.json の ask と git -C", () => {
  let env: ReturnType<typeof setupHookEnv>;
  beforeAll(() => { env = setupHookEnv(["Bash(git push *)", "Bash(git commit *)"]); });
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

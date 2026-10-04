import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseHookClient, shouldEmitAllow } from "./hook-response.ts";

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

// hook 本体をプロセスとして起動し、引数による出力の分岐を確認する。HOME は空の一時
// ディレクトリにして個人の ~/.claude/settings.json の影響を排除し、cwd 側で
// リポジトリ同梱の .claude/settings.json を読ませる。
describe("pre-tool-use-bash-analyzer (プロセス)", () => {
  let home: string;
  beforeAll(() => { home = mkdtempSync(join(tmpdir(), "hook-response-test-")); });
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  function runHook(command: string, args: readonly string[]) {
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      cwd: repoRoot,
    });
    const r = spawnSync("bun", [analyzer, ...args], {
      input,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    return { status: r.status, stdout: r.stdout };
  }

  test("Claude Code: git -C /repo status は permissionDecision allow を返す", () => {
    const r = runHook("git -C /repo status", ["--client=claude-code"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("Codex (引数無し): git -C /repo status は何も出力しない", () => {
    const r = runHook("git -C /repo status", []);
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: "" });
  });

  test("Claude Code: -C を含まない git status は従来どおり何も出力しない", () => {
    const r = runHook("git status", ["--client=claude-code"]);
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: "" });
  });

  test("Claude Code: git -C /repo reset --hard は deny", () => {
    const r = runHook("git -C /repo reset --hard", ["--client=claude-code"]);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  /** hook が出した permissionDecision。無出力 (pass-through) は null */
  function decisionOf(command: string): string | null {
    const r = runHook(command, ["--client=claude-code"]);
    expect(r.status).toBe(0);
    return r.stdout === "" ? null : JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
  }

  test.each([
    "git -C /r status",
    "git -C '/r x' log --oneline",
    "git --no-pager -C /r log",
    'git -C /r commit -m "x"',
    "git -C /r status && git -C /s diff",
  ])("Claude Code: %j は allow を返す", (command) => {
    expect(decisionOf(command)).toBe("allow");
  });

  // bash では改行・コメント・ANSI-C quoting の解釈で後続コマンドが別に実行される形、
  // およびコマンド名がパス指定で allow ルールの想定と別の実行ファイルを起動する形。
  // hook は allow を出さない (無出力で本体の判定に委ねる / ask / deny のいずれか)。
  test.each([
    "git -C /r status #'\ntouch /tmp/pwned",
    "git -C /r status #'\npython3 -c 'import os'\n#'",
    "git -C /r status #'\nrm -rf /tmp/x\n#'",
    "git -C /r log $'\\'' ; touch /tmp/pwned #'",
    'git -C /r commit -m "fix #12"',
    "./git -C . status",
    "/tmp/evil/git -C /r status",
    "git -C /r status; /tmp/evil/echo hi",
  ])("Claude Code: %j は allow を返さない", (command) => {
    expect(decisionOf(command)).not.toBe("allow");
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

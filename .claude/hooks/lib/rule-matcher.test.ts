import { describe, test, expect } from "bun:test";
import {
  matchCommand,
  stripShellPrefixes,
  checkDangerousGitFlags,
} from "./rule-matcher.ts";
import { loadRules } from "./rules.ts";
import { parseShellCommands } from "./shell-parser.ts";
import type { Rule } from "./types.ts";

/** matchCommand の decision だけを取り出すヘルパー */
function decision(command: string, rules: readonly Rule[]) {
  return matchCommand(command, rules)?.decision ?? null;
}

describe("matchCommand", () => {
  const rules: readonly Rule[] = [
    { category: "allow", pattern: "Bash(git status:*)" },
    { category: "allow", pattern: "Bash(git log:*)" },
    { category: "allow", pattern: "Bash(git diff:*)" },
    { category: "allow", pattern: "Bash(head *)" },
    { category: "allow", pattern: "Bash(tail *)" },
    { category: "allow", pattern: "Bash(pnpm build)" },
    { category: "allow", pattern: "Bash(pnpm test)" },
    { category: "allow", pattern: "Bash(grep *)" },
    { category: "allow", pattern: "Bash(pnpm vitest *)" },
    { category: "deny", pattern: "Bash(curl:*)" },
    { category: "deny", pattern: "Bash(rm:*)" },
    { category: "deny", pattern: "Bash(echo:*)" },
    { category: "deny", pattern: "Bash(git commit --no-verify:*)" },
    { category: "deny", pattern: "Bash(git push --force:*)" },
    { category: "ask", pattern: "Bash(pnpm install *)" },
    { category: "ask", pattern: "Bash(node:*)" },
  ];

  describe(":* パターン（プレフィックス + 空 or スペース+任意）", () => {
    test("プレフィックスのみでマッチする", () => {
      expect(decision("git status", rules)).toBe("allow");
    });

    test("プレフィックス + 引数でマッチする", () => {
      expect(decision("git status --short", rules)).toBe("allow");
    });

    test("プレフィックス + 複数引数でマッチする", () => {
      expect(decision("git log --oneline -n 10", rules)).toBe("allow");
    });
  });

  describe("スペース+* パターン（末尾では引数なしでもマッチ）", () => {
    test("引数付きでマッチする", () => {
      expect(decision("head -5", rules)).toBe("allow");
    });

    test("複数引数でマッチする", () => {
      expect(decision("head -n 20 file.txt", rules)).toBe("allow");
    });

    test("引数なしでもマッチする（公式仕様: 末尾の ` *` は end-of-string もマッチ）", () => {
      expect(decision("head", rules)).toBe("allow");
    });

    test("途中の ` *` は引数を要求する（例: git * main）", () => {
      const midRules: readonly Rule[] = [
        { category: "allow", pattern: "Bash(git * main)" },
      ];
      expect(decision("git checkout main", midRules)).toBe("allow");
      expect(matchCommand("git main", midRules)).toBeNull();
    });
  });

  describe("完全一致パターン", () => {
    test("完全一致でマッチする", () => {
      expect(decision("pnpm build", rules)).toBe("allow");
    });

    test("追加引数があるとマッチしない", () => {
      expect(matchCommand("pnpm build --filter admin", rules)).toBeNull();
    });
  });

  describe("deny ルール", () => {
    test("deny パターンにマッチする", () => {
      expect(decision("curl http://example.com", rules)).toBe("deny");
    });

    test("deny は allow より優先される", () => {
      const mixedRules: readonly Rule[] = [
        { category: "allow", pattern: "Bash(rm:*)" },
        { category: "deny", pattern: "Bash(rm:*)" },
      ];
      expect(decision("rm -rf /", mixedRules)).toBe("deny");
    });
  });

  describe("ask ルール", () => {
    test("ask パターンにマッチする", () => {
      expect(decision("pnpm install lodash", rules)).toBe("ask");
    });

    test(":* の ask パターンにマッチする", () => {
      expect(decision("node script.js", rules)).toBe("ask");
    });
  });

  describe(":* パターンでスペース区切りのコマンドがマッチする", () => {
    const taskRules: readonly Rule[] = [
      { category: "allow", pattern: "Bash(task :*)" },
    ];

    test("task init-setup がマッチする", () => {
      expect(decision("task init-setup", taskRules)).toBe("allow");
    });

    test("task 単体がマッチする", () => {
      expect(decision("task", taskRules)).toBe("allow");
    });

    test("task worktree:add がマッチする", () => {
      expect(decision("task worktree:add", taskRules)).toBe("allow");
    });
  });

  describe("未マッチ", () => {
    test("どのルールにもマッチしない場合 null を返す", () => {
      expect(matchCommand("python script.py", rules)).toBeNull();
    });
  });

  describe("MatchResult にパターン情報が含まれる", () => {
    test("deny 結果にマッチしたパターンが含まれる", () => {
      const result = matchCommand("curl http://example.com", rules);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe("deny");
      expect(result!.pattern).toBe("Bash(curl:*)");
      expect(result!.command).toBe("curl http://example.com");
    });

    test("allow 結果にマッチしたパターンが含まれる", () => {
      const result = matchCommand("git status", rules);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe("allow");
      expect(result!.pattern).toBe("Bash(git status:*)");
    });

    test("ask 結果にマッチしたパターンが含まれる", () => {
      const result = matchCommand("pnpm install lodash", rules);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe("ask");
      expect(result!.pattern).toBe("Bash(pnpm install *)");
    });

    test("危険 git フラグで deny された場合 pattern は dangerous-git-flags", () => {
      const rulesWithPush: readonly Rule[] = [
        ...rules,
        { category: "allow", pattern: "Bash(git push:*)" },
      ];
      const result = matchCommand("git push origin main --force", rulesWithPush);
      expect(result).not.toBeNull();
      expect(result!.decision).toBe("deny");
      expect(result!.pattern).toBe("dangerous-git-flags");
    });
  });

  describe("危険 git フラグの位置非依存検出", () => {
    test("git commit -m 'msg' --no-verify は deny", () => {
      expect(decision('git commit -m "msg" --no-verify', rules)).toBe("deny");
    });

    test("git commit --no-verify -m 'msg' は deny（既存動作確認）", () => {
      expect(decision('git commit --no-verify -m "msg"', rules)).toBe("deny");
    });

    test("git merge feature --no-verify は deny", () => {
      const rulesWithMerge: readonly Rule[] = [
        ...rules,
        { category: "allow", pattern: "Bash(git merge:*)" },
      ];
      expect(decision("git merge feature --no-verify", rulesWithMerge)).toBe(
        "deny",
      );
    });

    test("git push origin main --force は deny", () => {
      const rulesWithPush: readonly Rule[] = [
        ...rules,
        { category: "allow", pattern: "Bash(git push:*)" },
      ];
      expect(decision("git push origin main --force", rulesWithPush)).toBe(
        "deny",
      );
    });

    test("git push -f origin main は deny", () => {
      const rulesWithPush: readonly Rule[] = [
        ...rules,
        { category: "allow", pattern: "Bash(git push:*)" },
      ];
      expect(decision("git push -f origin main", rulesWithPush)).toBe("deny");
    });

    test("git push origin +main は deny", () => {
      const rulesWithPush: readonly Rule[] = [
        ...rules,
        { category: "allow", pattern: "Bash(git push:*)" },
      ];
      expect(decision("git push origin +main", rulesWithPush)).toBe("deny");
    });

    test("git push origin main は正常（allow ルールがあれば allow）", () => {
      const rulesWithPush: readonly Rule[] = [
        ...rules,
        { category: "allow", pattern: "Bash(git push:*)" },
      ];
      expect(decision("git push origin main", rulesWithPush)).toBe("allow");
    });

    test("git commit -m 'msg' は正常（allow ルールがあれば allow）", () => {
      const rulesWithCommit: readonly Rule[] = [
        ...rules,
        { category: "allow", pattern: "Bash(git commit:*)" },
      ];
      expect(decision('git commit -m "msg"', rulesWithCommit)).toBe("allow");
    });

    test("git commit -n は deny（-n は --no-verify の短縮形）", () => {
      const rulesWithCommit: readonly Rule[] = [
        ...rules,
        { category: "allow", pattern: "Bash(git commit:*)" },
      ];
      expect(decision('git commit -n -m "msg"', rulesWithCommit)).toBe("deny");
    });
  });

  describe("シェル制御構文プレフィックスの除去", () => {
    test("then git push --force origin main は deny", () => {
      expect(decision("then git push --force origin main", rules)).toBe("deny");
    });

    test("else curl https://example.com は deny", () => {
      expect(decision("else curl https://example.com", rules)).toBe("deny");
    });

    test("do rm -rf /tmp は deny", () => {
      expect(decision("do rm -rf /tmp", rules)).toBe("deny");
    });

    test("then git status は allow", () => {
      expect(decision("then git status", rules)).toBe("allow");
    });

    test("env GIT_TRACE=1 git status は allow", () => {
      expect(decision("env GIT_TRACE=1 git status", rules)).toBe("allow");
    });

    test("env VAR=val curl https://example.com は deny", () => {
      expect(decision("env VAR=val curl https://example.com", rules)).toBe(
        "deny",
      );
    });

    test("command git status は allow", () => {
      expect(decision("command git status", rules)).toBe("allow");
    });
  });
});

describe("stripShellPrefixes", () => {
  test("then を除去する", () => {
    expect(stripShellPrefixes("then git push")).toBe("git push");
  });

  test("else を除去する", () => {
    expect(stripShellPrefixes("else echo hello")).toBe("echo hello");
  });

  test("do を除去する", () => {
    expect(stripShellPrefixes("do rm file")).toBe("rm file");
  });

  test("elif を除去する", () => {
    expect(stripShellPrefixes("elif test -f foo")).toBe("test -f foo");
  });

  test("{ を除去する", () => {
    expect(stripShellPrefixes("{ git status")).toBe("git status");
  });

  test("env VAR=val を除去する", () => {
    expect(stripShellPrefixes("env GIT_TRACE=1 git status")).toBe("git status");
  });

  test("env 複数 VAR=val を除去する", () => {
    expect(stripShellPrefixes("env A=1 B=2 git status")).toBe("git status");
  });

  test("command を除去する", () => {
    expect(stripShellPrefixes("command git status")).toBe("git status");
  });

  test("nohup を除去する", () => {
    expect(stripShellPrefixes("nohup git push")).toBe("git push");
  });

  test("通常コマンドはそのまま返す", () => {
    expect(stripShellPrefixes("git status")).toBe("git status");
  });

  test("then 単独は空文字列", () => {
    expect(stripShellPrefixes("then")).toBe("");
  });
});

describe("checkDangerousGitFlags", () => {
  test("git commit -m msg --no-verify は true", () => {
    expect(checkDangerousGitFlags('git commit -m "msg" --no-verify')).toBe(
      true,
    );
  });

  test("git push origin main --force は true", () => {
    expect(checkDangerousGitFlags("git push origin main --force")).toBe(true);
  });

  test("git push -f origin main は true", () => {
    expect(checkDangerousGitFlags("git push -f origin main")).toBe(true);
  });

  test("git push origin +main は true", () => {
    expect(checkDangerousGitFlags("git push origin +main")).toBe(true);
  });

  test("git push --force-with-lease は true", () => {
    expect(checkDangerousGitFlags("git push --force-with-lease origin main")).toBe(true);
  });

  test("git push --delete origin branch は true", () => {
    expect(checkDangerousGitFlags("git push --delete origin branch")).toBe(
      true,
    );
  });

  test("git push origin main は false", () => {
    expect(checkDangerousGitFlags("git push origin main")).toBe(false);
  });

  test("git commit -m msg は false", () => {
    expect(checkDangerousGitFlags('git commit -m "msg"')).toBe(false);
  });

  test("非 git コマンドは false", () => {
    expect(checkDangerousGitFlags("curl --force")).toBe(false);
  });

  test("then git push --force は true（シェルプレフィックス考慮）", () => {
    expect(checkDangerousGitFlags("then git push --force origin main")).toBe(
      true,
    );
  });
});

/**
 * 統合テスト: 実際の settings.json ルールを使った判定検証
 */
describe("統合テスト: settings.json ルールでの判定", () => {
  const settingsRules = loadRules();

  /** 複合コマンドの全サブコマンドを判定し、最終結果を返す */
  function judgeCommand(command: string): "allow" | "deny" | "ask" {
    const subs = parseShellCommands(command);
    let hasAsk = false;
    for (const sub of subs) {
      const result = matchCommand(sub, settingsRules);
      if (result === null) continue; // 未マッチ = allow
      if (result.decision === "deny") return "deny";
      if (result.decision === "ask") hasAsk = true;
    }
    return hasAsk ? "ask" : "allow";
  }

  describe("allow 系: 読み取り git コマンド", () => {
    test("git status", () => expect(judgeCommand("git status")).toBe("allow"));
    test("git status --short", () => expect(judgeCommand("git status --short")).toBe("allow"));
    test("git diff", () => expect(judgeCommand("git diff")).toBe("allow"));
    test("git diff HEAD~1", () => expect(judgeCommand("git diff HEAD~1")).toBe("allow"));
    test("git log --oneline -n 10", () => expect(judgeCommand("git log --oneline -n 10")).toBe("allow"));
    test("git branch", () => expect(judgeCommand("git branch")).toBe("allow"));
    test("git branch -a", () => expect(judgeCommand("git branch -a")).toBe("allow"));
  });

  describe("allow 系: 書き込み git コマンド（危険フラグなし）", () => {
    test("git add file.ts", () => expect(judgeCommand("git add file.ts")).toBe("allow"));
    test('git commit -m "msg"', () => expect(judgeCommand('git commit -m "msg"')).toBe("allow"));
    test("git push origin main", () => expect(judgeCommand("git push origin main")).toBe("allow"));
    test("git stash", () => expect(judgeCommand("git stash")).toBe("allow"));
    test("git fetch origin", () => expect(judgeCommand("git fetch origin")).toBe("allow"));
    test("git pull", () => expect(judgeCommand("git pull")).toBe("allow"));
    test("git merge feature", () => expect(judgeCommand("git merge feature")).toBe("allow"));
    test("git switch -c new-branch", () => expect(judgeCommand("git switch -c new-branch")).toBe("allow"));
    test("git worktree add ../wt main", () => expect(judgeCommand("git worktree add ../wt main")).toBe("allow"));
  });

  describe("allow 系: パイプ後段フィルタ", () => {
    test("head -5", () => expect(judgeCommand("head -5")).toBe("allow"));
    test("tail -20", () => expect(judgeCommand("tail -20")).toBe("allow"));
    test("wc -l", () => expect(judgeCommand("wc -l")).toBe("allow"));
    test("sort", () => expect(judgeCommand("sort")).toBe("allow"));
    test("grep pattern", () => expect(judgeCommand("grep pattern")).toBe("allow"));
  });

  describe("allow 系: 開発ツール", () => {
    test("bun test", () => expect(judgeCommand("bun test")).toBe("allow"));
    test("bun test lib/rule-matcher.test.ts", () => expect(judgeCommand("bun test lib/rule-matcher.test.ts")).toBe("allow"));
    test("mkdir -p src/lib", () => expect(judgeCommand("mkdir -p src/lib")).toBe("allow"));
    test("pnpm build", () => expect(judgeCommand("pnpm build")).toBe("allow"));
    test("make build", () => expect(judgeCommand("make build")).toBe("allow"));
    test("docker ps", () => expect(judgeCommand("docker ps")).toBe("allow"));
    test("nix build", () => expect(judgeCommand("nix build")).toBe("allow"));
  });

  describe("deny 系: 禁止コマンド", () => {
    test("ls", () => expect(judgeCommand("ls")).toBe("deny"));
    test("ls -la", () => expect(judgeCommand("ls -la")).toBe("deny"));
    test("cat foo.txt", () => expect(judgeCommand("cat foo.txt")).toBe("deny"));
    test("cd /tmp", () => expect(judgeCommand("cd /tmp")).toBe("deny"));
    test("rm -rf /tmp", () => expect(judgeCommand("rm -rf /tmp")).toBe("deny"));
    test("echo hello", () => expect(judgeCommand("echo hello")).toBe("deny"));
    test('find . -name "*.ts"', () => expect(judgeCommand('find . -name "*.ts"')).toBe("deny"));
    test("sudo apt install", () => expect(judgeCommand("sudo apt install")).toBe("deny"));
    test("curl https://example.com", () => expect(judgeCommand("curl https://example.com")).toBe("deny"));
  });

  describe("deny 系: dangerous-git-flags", () => {
    test("git push --force origin main", () => expect(judgeCommand("git push --force origin main")).toBe("deny"));
    test("git push -f origin main", () => expect(judgeCommand("git push -f origin main")).toBe("deny"));
    test('git commit --no-verify -m "msg"', () => expect(judgeCommand('git commit --no-verify -m "msg"')).toBe("deny"));
    test('git commit -n -m "msg"', () => expect(judgeCommand('git commit -n -m "msg"')).toBe("deny"));
    test("git add .", () => expect(judgeCommand("git add .")).toBe("deny"));
    test("git add -A", () => expect(judgeCommand("git add -A")).toBe("deny"));
    test("git push --delete origin branch", () => expect(judgeCommand("git push --delete origin branch")).toBe("deny"));
  });

  describe("ask 系", () => {
    test("pnpm install lodash", () => expect(judgeCommand("pnpm install lodash")).toBe("ask"));
  });

  describe("未マッチ → allow", () => {
    test("python script.py", () => expect(judgeCommand("python script.py")).toBe("allow"));
    test("node index.js", () => expect(judgeCommand("node index.js")).toBe("allow"));
  });

  describe("複合コマンド（パイプ / && / リダイレクト）", () => {
    test("git status && git diff → allow", () => {
      expect(judgeCommand("git status && git diff")).toBe("allow");
    });

    test("git status && rm -rf / → deny", () => {
      expect(judgeCommand("git status && rm -rf /")).toBe("deny");
    });

    test("git log --oneline | head -5 → allow", () => {
      expect(judgeCommand("git log --oneline | head -5")).toBe("allow");
    });

    test("git status 2>&1 | tail -20 → allow", () => {
      expect(judgeCommand("git status 2>&1 | tail -20")).toBe("allow");
    });

    test("git diff HEAD~1 2>&1 | head -20 → allow", () => {
      expect(judgeCommand("git diff HEAD~1 2>&1 | head -20")).toBe("allow");
    });

    test("git status && ls → deny (ls が deny)", () => {
      expect(judgeCommand("git status && ls")).toBe("deny");
    });

    test("pnpm build 2>&1 | tail -20 → allow (pnpm allow, tail allow)", () => {
      expect(judgeCommand("pnpm build 2>&1 | tail -20")).toBe("allow");
    });
  });
});

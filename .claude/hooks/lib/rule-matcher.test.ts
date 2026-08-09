import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import {
  matchCommand,
  stripShellPrefixes,
  checkDangerousGitFlags,
  extractBashPattern,
  patternToRegex,
} from "./rule-matcher.ts";
import { loadRules } from "./rules.ts";
import { parseShellCommands } from "./shell-parser.ts";
import { evaluateCommand } from "./evaluator.ts";
import type { Rule, RuleCategory } from "./types.ts";

/** テスト用 Rule 作成ヘルパー（regex をプリコンパイル） */
function rule(category: RuleCategory, pattern: string): Rule {
  const bashPattern = extractBashPattern(pattern);
  return { category, pattern, regex: bashPattern ? patternToRegex(bashPattern) : /(?!)/ };
}

/** matchCommand の decision だけを取り出すヘルパー */
function decision(command: string, rules: readonly Rule[]) {
  return matchCommand(command, rules)?.decision ?? null;
}

describe("matchCommand", () => {
  const rules: readonly Rule[] = [
    rule("allow", "Bash(git status:*)"),
    rule("allow", "Bash(git log:*)"),
    rule("allow", "Bash(git diff:*)"),
    rule("allow", "Bash(head *)"),
    rule("allow", "Bash(tail *)"),
    rule("allow", "Bash(pnpm build)"),
    rule("allow", "Bash(pnpm test)"),
    rule("allow", "Bash(grep *)"),
    rule("allow", "Bash(pnpm vitest *)"),
    rule("deny", "Bash(curl:*)"),
    rule("deny", "Bash(rm:*)"),
    rule("deny", "Bash(echo:*)"),
    rule("deny", "Bash(git commit --no-verify:*)"),
    rule("deny", "Bash(git push --force:*)"),
    rule("ask", "Bash(pnpm install *)"),
    rule("ask", "Bash(node:*)"),
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

    test("改行を含むコマンドにもマッチする（HEREDOC）", () => {
      const catRules: readonly Rule[] = [rule("deny", "Bash(cat *)")];
      expect(decision("cat <<'EOF'\nContent here\nEOF", catRules)).toBe("deny");
    });

    test("途中の ` *` は引数を要求する（例: git * main）", () => {
      const midRules: readonly Rule[] = [
        rule("allow", "Bash(git * main)"),
      ];
      // サンプルには破壊的サブコマンド (reset/rebase/checkout) を使わないこと。
      // matchCommand は allow 判定より前に checkDangerousGitFlags を通すため、
      // それらを使うとパターン形状ではなく危険 git ガードを測ってしまう。
      expect(decision("git switch main", midRules)).toBe("allow");
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
        rule("allow", "Bash(rm:*)"),
        rule("deny", "Bash(rm:*)"),
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
      rule("allow", "Bash(task :*)"),
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
        rule("allow", "Bash(git push:*)"),
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
        rule("allow", "Bash(git merge:*)"),
      ];
      expect(decision("git merge feature --no-verify", rulesWithMerge)).toBe(
        "deny",
      );
    });

    test("git push origin main --force は deny", () => {
      const rulesWithPush: readonly Rule[] = [
        ...rules,
        rule("allow", "Bash(git push:*)"),
      ];
      expect(decision("git push origin main --force", rulesWithPush)).toBe(
        "deny",
      );
    });

    test("git push -f origin main は deny", () => {
      const rulesWithPush: readonly Rule[] = [
        ...rules,
        rule("allow", "Bash(git push:*)"),
      ];
      expect(decision("git push -f origin main", rulesWithPush)).toBe("deny");
    });

    test("git push origin +main は deny", () => {
      const rulesWithPush: readonly Rule[] = [
        ...rules,
        rule("allow", "Bash(git push:*)"),
      ];
      expect(decision("git push origin +main", rulesWithPush)).toBe("deny");
    });

    test("git push origin main は正常（allow ルールがあれば allow）", () => {
      const rulesWithPush: readonly Rule[] = [
        ...rules,
        rule("allow", "Bash(git push:*)"),
      ];
      expect(decision("git push origin main", rulesWithPush)).toBe("allow");
    });

    test("git commit -m 'msg' は正常（allow ルールがあれば allow）", () => {
      const rulesWithCommit: readonly Rule[] = [
        ...rules,
        rule("allow", "Bash(git commit:*)"),
      ];
      expect(decision('git commit -m "msg"', rulesWithCommit)).toBe("allow");
    });

    test("git commit -n は deny（-n は --no-verify の短縮形）", () => {
      const rulesWithCommit: readonly Rule[] = [
        ...rules,
        rule("allow", "Bash(git commit:*)"),
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

  // 破壊的サブコマンド (reset / rebase / checkout) は settings.json の deny
  // (`Bash(git reset *)` 等) がプレフィックス一致なので、`-C` / `--git-dir` 等の
  // global option を挟まれると素通りしていた。global option 正規化後の
  // サブコマンドで捕捉し、ディレクトリ迂回でも同じ判定になることを固定する。
  describe("破壊的サブコマンドは global option を挟んでも true", () => {
    for (const cmd of [
      "git -C /tmp/x reset --hard",
      "git -C /tmp/x rebase main",
      "git -C /tmp/x checkout -- .",
      "git --git-dir /tmp/x/.git reset --hard",
      "git --work-tree /tmp/x checkout main",
      "git -c core.pager=cat reset --hard",
      "git reset --hard",
      "git rebase main",
      "git checkout main",
    ]) {
      test(cmd, () => expect(checkDangerousGitFlags(cmd)).toBe(true));
    }
  });

  // 区切り文字がタブでも、サブコマンドがクォートされていても迂回できないこと。
  // どちらも settings.json の deny (リテラルスペース前提のプレフィックス一致) では
  // 捕捉できないため、このガードが最後の砦になる。
  describe("タブ区切り / クォートでも迂回できない", () => {
    for (const cmd of [
      "git\t-C /tmp/x reset --hard",
      "git\treset --hard",
      "git\tpush --force origin main",
      "git 'reset' --hard",
      'git "reset" --hard',
      "git re'set' --hard",
      "git -C /tmp/x 'checkout' -- .",
    ]) {
      test(JSON.stringify(cmd), () => expect(checkDangerousGitFlags(cmd)).toBe(true));
    }
  });

  // ANSI-C quoting ($'...')。tokenizeCommand が $ を通常文字として扱うと
  // トークンが `$--force` に化けて normalizeArg の ANSI-C 分岐にも二度と入らず、
  // フラグ比較から漏れる (split(/\s+/) 時代は素の `$'--force'` が normalizeArg で
  // 正規化されて deny になっていたため、トークナイザ導入時の退行になりうる)。
  describe("ANSI-C quoting ($'...') でも迂回できない", () => {
    for (const cmd of [
      "git push $'--force' origin main",
      "git $'reset' --hard",
      "git -C /tmp/x $'reset' --hard",
      "git commit $'--no-verify' -m x",
      "git $'-C' /tmp/x reset --hard",
    ]) {
      test(JSON.stringify(cmd), () => expect(checkDangerousGitFlags(cmd)).toBe(true));
    }

    test("ANSI-C quoting でも読み取り系は false", () => {
      expect(checkDangerousGitFlags("git $'status'")).toBe(false);
    });

    // bash は $'...' 内のエスケープシーケンスを実際に展開する。リテラル文字形だけを
    // 通してもエスケープ形が素通りするので、デコードまでやらないとガードにならない。
    describe("エスケープシーケンスを復号する", () => {
      for (const [cmd, why] of [
        ["git $'\\x72eset' --hard", "\\xHH (16進)"],
        ["git $'\\162eset' --hard", "\\nnn (8進)"],
        ["git $'\\u0072eset' --hard", "\\uHHHH"],
        ["git $'\\U00000072eset' --hard", "\\UHHHHHHHH"],
        ["git push $'\\x2d\\x2dforce' origin main", "16進を連結して --force"],
        ["git $'\\x2dC' /tmp/x reset --hard", "global option 側を 16進で"],
        ["git commit $'\\x2d\\x2dno\\x2dverify' -m x", "16進で --no-verify"],
      ] as const) {
        test(`${why}: ${JSON.stringify(cmd)}`, () =>
          expect(checkDangerousGitFlags(cmd)).toBe(true));
      }

      test("復号しても読み取り系は false", () => {
        // $'\x73tatus' → "status"
        expect(checkDangerousGitFlags("git $'\\x73tatus'")).toBe(false);
      });
    });
  });

  // コマンド名側の迂回。matchCommand は checkDangerousGitFlags に正規化前の生コマンドを
  // 渡すため、入口の git 判定でもクォート除去とベース名抽出が要る。
  // `-C` 無しの形は normalizeCommandName 経由の候補が deny ルールに当たるので塞がっているが、
  // `Bash(git -C *)` の deny を外した本 PR では `-C` 付きがこのガード頼みになる。
  describe("コマンド名がクォート / フルパスでも迂回できない", () => {
    for (const cmd of [
      '"git" -C /tmp/x reset --hard',
      "'git' -C /tmp/x rebase main",
      "/usr/bin/git -C /tmp/x checkout -- .",
      "/opt/homebrew/bin/git -C /tmp/x reset --hard",
      'g"i"t -C /tmp/x reset --hard',
    ]) {
      test(JSON.stringify(cmd), () => expect(checkDangerousGitFlags(cmd)).toBe(true));
    }

    test("読み取り系は素通ししない (false のまま)", () => {
      expect(checkDangerousGitFlags("/usr/bin/git -C /tmp/x status")).toBe(false);
      expect(checkDangerousGitFlags('"git" -C /tmp/x log')).toBe(false);
    });

    test("git 以外のコマンドを巻き込まない", () => {
      expect(checkDangerousGitFlags("/usr/bin/gitk -C /tmp/x reset --hard")).toBe(false);
      expect(checkDangerousGitFlags("/usr/bin/legit -C /tmp/x reset --hard")).toBe(false);
    });
  });

  // -C の引数にスペースが含まれると split(/\s+/) がパスを分割してしまい、
  // サブコマンドを取り違えて判定を落としていた。
  describe("-C 引数にスペースを含んでも迂回できない", () => {
    for (const cmd of [
      "git -C '/tmp/repo with spaces' reset --hard",
      'git -C "/tmp/repo with spaces" reset --hard',
      "git -C /tmp/repo\\ with\\ spaces reset --hard",
      "git -C '/tmp/repo with spaces' checkout -- .",
    ]) {
      test(JSON.stringify(cmd), () => expect(checkDangerousGitFlags(cmd)).toBe(true));
    }

    test("スペース入りパスでも読み取り系は false", () => {
      expect(checkDangerousGitFlags("git -C '/tmp/repo with spaces' status")).toBe(false);
    });
  });

  test("読み取り系は -C 付きでも false", () => {
    expect(checkDangerousGitFlags("git -C /tmp/x status")).toBe(false);
    expect(checkDangerousGitFlags("git -C /tmp/x log")).toBe(false);
    expect(checkDangerousGitFlags("git -C /tmp/x diff")).toBe(false);
  });

  test("git switch は対象外（allow のまま）", () => {
    expect(checkDangerousGitFlags("git -C /tmp/x switch main")).toBe(false);
  });
});

/**
 * 統合テスト: 実際の settings.json ルールを使った判定検証
 */
describe("統合テスト: settings.json ルールでの判定", () => {
  // CI には個人の ~/.claude/settings.json が存在しないため、リポジトリ同梱の
  // .claude/settings.json を明示的に読む (import.meta.dir = .claude/hooks/lib)。
  const repoRoot = resolve(import.meta.dir, "..", "..", "..");
  const settingsRules = loadRules(repoRoot);

  /** 複合コマンドの全サブコマンドを判定し、最終結果を返す */
  function judgeCommand(command: string): "allow" | "deny" | "ask" {
    const subs = parseShellCommands(command);
    return evaluateCommand(subs, settingsRules).decision;
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
    test("pnpm build（未マッチ→pass-through allow）", () => expect(judgeCommand("pnpm build")).toBe("allow"));
    test("make build", () => expect(judgeCommand("make build")).toBe("allow"));
    test("docker ps", () => expect(judgeCommand("docker ps")).toBe("allow"));
    test("nix build", () => expect(judgeCommand("nix build")).toBe("allow"));
  });

  describe("deny 系: 禁止コマンド", () => {
    test("cat foo.txt", () => expect(judgeCommand("cat foo.txt")).toBe("deny"));
    test("cd /tmp", () => expect(judgeCommand("cd /tmp")).toBe("deny"));
    test("rm -rf /tmp", () => expect(judgeCommand("rm -rf /tmp")).toBe("deny"));
    test("echo hello → allow (settings.json で echo は allow に登録済)", () => {
      expect(judgeCommand("echo hello")).toBe("allow");
    });
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

  describe("未マッチ → pass-through allow", () => {
    test("python script.py", () => expect(judgeCommand("python script.py")).toBe("allow"));
    test("node index.js", () => expect(judgeCommand("node index.js")).toBe("allow"));
    // `Bash(ls *)` は settings.json の deny から意図的に除外した (allow にも無く未マッチ)。
    test("ls", () => expect(judgeCommand("ls")).toBe("allow"));
    test("ls -la", () => expect(judgeCommand("ls -la")).toBe("allow"));

    // `Bash(git -C *)` も deny から意図的に除外した。別ディレクトリに対する
    // 読み取り系 git を通すための緩和で、以下はその意図を固定するテスト。
    //
    // 姉妹オプションの `Bash(git --git-dir *)` / `Bash(git --work-tree *)` は deny の
    // ままで、扱いは揃っていない。緩和したのは実運用で使う `-C` だけ、というのが
    // 現状で、`--git-dir` / `--work-tree` を同じく緩和すべきかは未判断
    // (使う場面が無いので deny のまま倒している)。
    // なお破壊的サブコマンドはどのオプション形式でも checkDangerousGitFlags が
    // 捕捉するので、この非対称は読み取り系が通るかどうかの差でしかない。
    //
    // 緩和されるのは読み取り系だけで、破壊的サブコマンドは -C を挟んでも
    // checkDangerousGitFlags が deny にする (下の deny 系テストを参照)。
    //
    // ⚠️ ただし deny になるのは DANGEROUS_GIT_FLAGS に載っているものだけ。
    // 表に無い破壊系 (`git -C <dir> update-ref -d ...` / `git -C <dir> stash drop` 等) は
    // pass-through allow のままで、`-C` 緩和によって「他ディレクトリのリポジトリにも
    // 届く」ようになっている点は受容している (CWD 相当の `git update-ref ...` は
    // 元から pass-through allow だったため、増えたのは到達範囲のみ)。
    // 必要になったら DANGEROUS_GIT_FLAGS に追加して塞ぐこと。
    test("git -C /tmp/x status", () => expect(judgeCommand("git -C /tmp/x status")).toBe("allow"));
    test("git -C /tmp/x log", () => expect(judgeCommand("git -C /tmp/x log")).toBe("allow"));
    test("git -C /tmp/x diff", () => expect(judgeCommand("git -C /tmp/x diff")).toBe("allow"));
  });

  describe("deny 系: -C でディレクトリ迂回した破壊的 git", () => {
    test("git -C /tmp/x reset --hard", () =>
      expect(judgeCommand("git -C /tmp/x reset --hard")).toBe("deny"));
    test("git -C /tmp/x rebase main", () =>
      expect(judgeCommand("git -C /tmp/x rebase main")).toBe("deny"));
    test("git -C /tmp/x checkout -- .", () =>
      expect(judgeCommand("git -C /tmp/x checkout -- .")).toBe("deny"));
    test("タブ区切り: git\\t-C /tmp/x reset --hard", () =>
      expect(judgeCommand("git\t-C /tmp/x reset --hard")).toBe("deny"));
    test("クォート: git 'reset' --hard", () =>
      expect(judgeCommand("git 'reset' --hard")).toBe("deny"));
    test('コマンド名クォート: "git" -C /tmp/x reset --hard', () =>
      expect(judgeCommand('"git" -C /tmp/x reset --hard')).toBe("deny"));
    test("フルパス: /usr/bin/git -C /tmp/x checkout -- .", () =>
      expect(judgeCommand("/usr/bin/git -C /tmp/x checkout -- .")).toBe("deny"));
    test("スペース入りパス: git -C '/tmp/repo with spaces' reset --hard", () =>
      expect(judgeCommand("git -C '/tmp/repo with spaces' reset --hard")).toBe("deny"));
    test("ANSI-C quoting: git $'reset' --hard", () =>
      expect(judgeCommand("git $'reset' --hard")).toBe("deny"));
    test("ANSI-C quoting: git push $'--force' origin main", () =>
      expect(judgeCommand("git push $'--force' origin main")).toBe("deny"));
    test("ANSI-C escape: git $'\\x72eset' --hard", () =>
      expect(judgeCommand("git $'\\x72eset' --hard")).toBe("deny"));
    test("ANSI-C escape: git push $'\\x2d\\x2dforce' origin main", () =>
      expect(judgeCommand("git push $'\\x2d\\x2dforce' origin main")).toBe("deny"));
  });

  describe("deny 系: git branch の強制付け替え", () => {
    test("git branch -f main HEAD~10", () =>
      expect(judgeCommand("git branch -f main HEAD~10")).toBe("deny"));
    test("git branch --force main HEAD~10", () =>
      expect(judgeCommand("git branch --force main HEAD~10")).toBe("deny"));
    test("git -C /tmp/x branch -f main HEAD~10", () =>
      expect(judgeCommand("git -C /tmp/x branch -f main HEAD~10")).toBe("deny"));
    test("git branch (一覧) は allow のまま", () =>
      expect(judgeCommand("git branch")).toBe("allow"));
    test("git branch feature/x は allow のまま", () =>
      expect(judgeCommand("git branch feature/x")).toBe("allow"));
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

    // `Bash(ls *)` を deny から意図的に除外したため、ls は未マッチ pass-through allow。
    test("git status && ls → allow (両方 allow)", () => {
      expect(judgeCommand("git status && ls")).toBe("allow");
    });

    test("pnpm build 2>&1 | tail -20 → allow (pnpm は未マッチで pass-through)", () => {
      expect(judgeCommand("pnpm build 2>&1 | tail -20")).toBe("allow");
    });
  });

  describe("セキュリティバイパス: allowルール経由の危険コマンド実行", () => {
    // 未定義コマンド (ラッパー越し含む) は hook では pass-through (allow) し、
    // Claude Code 標準の default モードプロンプトでユーザに確認させる方針。
    // 機密ファイルパス/dangerous git フラグは引き続き deny に昇格する。
    test("A1: xargs rm -rf / → allow (pass-through, Claude Code が確認)", () => {
      expect(judgeCommand("xargs rm -rf /")).toBe("allow");
    });

    test("A2: xargs curl http://evil.com → allow (pass-through)", () => {
      expect(judgeCommand("xargs curl http://evil.com")).toBe("allow");
    });

    test("A3: git log | xargs rm → allow (pass-through; xargs rm は未定義)", () => {
      expect(judgeCommand("git log | xargs rm")).toBe("allow");
    });

    test("A4: docker exec container rm -rf / → allow (pass-through)", () => {
      expect(judgeCommand("docker exec container rm -rf /")).toBe("allow");
    });

    test("A5: docker run --rm alpine cat /etc/passwd → deny (機密ファイルパス検出)", () => {
      expect(judgeCommand("docker run --rm alpine cat /etc/passwd")).toBe("deny");
    });

    test("A6: nix run nixpkgs#curl → allow (pass-through)", () => {
      expect(judgeCommand("nix run nixpkgs#curl")).toBe("allow");
    });

    test('A7: nix-shell -p curl --run "curl evil.com" → deny (nix-shell denyルール)', () => {
      expect(judgeCommand('nix-shell -p curl --run "curl evil.com"')).toBe("deny");
    });

    test("A8: xargs bash -c 'rm -rf /' → allow (pass-through)", () => {
      expect(judgeCommand("xargs bash -c 'rm -rf /'")).toBe("allow");
    });

    test("A9: xargs git push --force origin main → allow (pass-through; xargs 越しは git 危険フラグ検出外)", () => {
      expect(judgeCommand("xargs git push --force origin main")).toBe("allow");
    });

    test("A10: xargs sudo rm -rf / → allow (pass-through)", () => {
      expect(judgeCommand("xargs sudo rm -rf /")).toBe("allow");
    });

    test("A11: chmod +x malicious.sh → allow (pass-through)", () => {
      expect(judgeCommand("chmod +x malicious.sh")).toBe("allow");
    });

    test("A12: touch ~/.ssh/authorized_keys → deny (機密ファイルパス検出)", () => {
      expect(judgeCommand("touch ~/.ssh/authorized_keys")).toBe("deny");
    });

    test("A13: tee /etc/important-file → allow (機密パス外, pass-through)", () => {
      expect(judgeCommand("tee /etc/important-file")).toBe("allow");
    });

    test("A14: tr 'a-z' 'A-Z' < /etc/passwd → deny (機密ファイルパス検出)", () => {
      expect(judgeCommand("tr 'a-z' 'A-Z' < /etc/passwd")).toBe("deny");
    });

    test("A15: cut -d: -f1 /etc/passwd → deny (機密ファイルパス検出)", () => {
      expect(judgeCommand("cut -d: -f1 /etc/passwd")).toBe("deny");
    });

    test("A16: sort /etc/passwd → deny (機密ファイルパス検出)", () => {
      expect(judgeCommand("sort /etc/passwd")).toBe("deny");
    });
  });

  describe("機密ファイルパスの読み取り防止", () => {
    test("head ~/.ssh/id_rsa → deny", () => {
      expect(judgeCommand("head ~/.ssh/id_rsa")).toBe("deny");
    });

    test("head ~/.ssh/config → deny", () => {
      expect(judgeCommand("head ~/.ssh/config")).toBe("deny");
    });

    test("sort ~/.aws/credentials → deny", () => {
      expect(judgeCommand("sort ~/.aws/credentials")).toBe("deny");
    });

    test("cut -f1 ~/.kube/config → deny", () => {
      expect(judgeCommand("cut -f1 ~/.kube/config")).toBe("deny");
    });

    test("sort .env → deny", () => {
      expect(judgeCommand("sort .env")).toBe("deny");
    });

    test("cut -d= -f2 .env.local → deny", () => {
      expect(judgeCommand("cut -d= -f2 .env.local")).toBe("deny");
    });

    test("sort /etc/shadow → deny", () => {
      expect(judgeCommand("sort /etc/shadow")).toBe("deny");
    });

    test("head ~/.gnupg/secring.gpg → deny", () => {
      expect(judgeCommand("head ~/.gnupg/secring.gpg")).toBe("deny");
    });

    test("tail ~/.netrc → deny", () => {
      expect(judgeCommand("tail ~/.netrc")).toBe("deny");
    });

    test("head authorized_keys → deny", () => {
      expect(judgeCommand("head authorized_keys")).toBe("deny");
    });

    test("sort file.txt → allow (非機密ファイル)", () => {
      expect(judgeCommand("sort file.txt")).toBe("allow");
    });

    test("cut -f1 data.csv → allow (非機密ファイル)", () => {
      expect(judgeCommand("cut -f1 data.csv")).toBe("allow");
    });

    test("tr 'a-z' 'A-Z' → allow (ファイル引数なし)", () => {
      expect(judgeCommand("tr 'a-z' 'A-Z'")).toBe("allow");
    });

    test("grep pattern file.ts → allow (非機密ファイル)", () => {
      expect(judgeCommand("grep pattern file.ts")).toBe("allow");
    });

    test("git commit -m に機密パス名が含まれてもallow（クォート内は無視）", () => {
      expect(judgeCommand('git commit -m "fix .env handling"')).toBe("allow");
    });

    test("git commit -m に /etc/passwd が含まれてもallow（クォート内は無視）", () => {
      expect(judgeCommand('git commit -m "update /etc/passwd docs"')).toBe("allow");
    });

    test("git commit -m にSSH鍵パスが含まれてもallow（クォート内は無視）", () => {
      expect(judgeCommand('git commit -m "add ~/.ssh/config guide"')).toBe("allow");
    });

    test("シングルクォート内の機密パスも無視する", () => {
      expect(judgeCommand("git tag -a v1.0 -m 'fix .env loading'")).toBe("allow");
    });
  });

  describe("セキュリティバイパス: deny回避によるask化", () => {
    test("B1: r'm' -rf / → deny (mid-word single quote)", () => {
      expect(judgeCommand("r'm' -rf /")).toBe("deny");
    });

    test('B2: "r"m -rf / → deny (mid-word double quote)', () => {
      expect(judgeCommand('"r"m -rf /')).toBe("deny");
    });

    test("B3: r\\m -rf / → deny (バックスラッシュ正規化、確認用)", () => {
      expect(judgeCommand("r\\m -rf /")).toBe("deny");
    });

    test("B4: ((rm -rf /)) → deny (二重括弧)", () => {
      expect(judgeCommand("((rm -rf /))")).toBe("deny");
    });

    test("B5: git -c key=val push --force origin main → deny (git global options)", () => {
      expect(judgeCommand("git -c key=val push --force origin main")).toBe("deny");
    });

    test("B6: git --no-optional-locks push --force origin main → deny", () => {
      expect(judgeCommand("git --no-optional-locks push --force origin main")).toBe("deny");
    });

    test("B7: env -i rm -rf / → deny (envフラグ)", () => {
      expect(judgeCommand("env -i rm -rf /")).toBe("deny");
    });

    test("B8: env -u PATH rm -rf / → deny (env -u フラグ)", () => {
      expect(judgeCommand("env -u PATH rm -rf /")).toBe("deny");
    });
  });

  describe("セキュリティバイパス: 境界ケース", () => {
    test('C1: git commit -am "msg" → deny (-a は広範ステージング)', () => {
      expect(judgeCommand('git commit -am "msg"')).toBe("deny");
    });

    test("C2: git push origin :main → deny (refspec削除)", () => {
      expect(judgeCommand("git push origin :main")).toBe("deny");
    });

    test("C3: git add ./././. → deny (冗長パス正規化)", () => {
      expect(judgeCommand("git add ./././.")).toBe("deny");
    });

    test("C4: git restore . → deny (positionalArgs)", () => {
      expect(judgeCommand("git restore .")).toBe("deny");
    });
  });
});

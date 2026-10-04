import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluateCommand, isAssignmentOnly } from "./evaluator.ts";
import { loadRules } from "./rules.ts";
import { parseShellCommands } from "./shell-parser.ts";

const worktreeRoot = resolve(import.meta.dir, "..", "..", "..");

/**
 * リポジトリ同梱の settings.json だけからルールを読む。loadRules は $HOME 配下の
 * ~/.claude/settings.json 等もマージするので、HOME を空の一時ディレクトリに差し替えて
 * 個人設定の影響 (ローカルの allow / deny の有無でテスト結果が変わること) を排除する。
 */
function loadRepoRules() {
  const home = mkdtempSync(join(tmpdir(), "evaluator-test-"));
  const original = process.env.HOME;
  process.env.HOME = home;
  try {
    return loadRules(worktreeRoot);
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("isAssignmentOnly", () => {
  test("単純な代入", () => {
    expect(isAssignmentOnly("FOO=bar")).toBe(true);
  });

  test("複数の代入", () => {
    expect(isAssignmentOnly("FOO=bar BAZ=qux")).toBe(true);
  });

  test("コマンド置換を伴う代入", () => {
    expect(isAssignmentOnly("foo=$(git status)")).toBe(true);
  });

  test("ネストした $() を含む代入", () => {
    expect(isAssignmentOnly("foo=$(git log $(git rev-parse HEAD))")).toBe(true);
  });

  test("クォートされた値の代入", () => {
    expect(isAssignmentOnly('FOO="bar baz"')).toBe(true);
    expect(isAssignmentOnly("FOO='bar baz'")).toBe(true);
  });

  test("バッククォートを含む代入", () => {
    expect(isAssignmentOnly("foo=`git status`")).toBe(true);
  });

  test("代入後にコマンドがあるものは false", () => {
    expect(isAssignmentOnly("FOO=bar git status")).toBe(false);
  });

  test("通常のコマンドは false", () => {
    expect(isAssignmentOnly("git status")).toBe(false);
  });

  test("空文字列は false", () => {
    expect(isAssignmentOnly("")).toBe(false);
    expect(isAssignmentOnly("   ")).toBe(false);
  });

  test("数字始まりの変数名は代入として認識しない", () => {
    expect(isAssignmentOnly("1foo=bar")).toBe(false);
  });

  test("ネストした $() とクォートを含む実際の代入パターン", () => {
    expect(
      isAssignmentOnly(
        `pr_number=$(gh pr list --head "$(git branch --show-current)" --state open --json number --jq '.[0].number')`,
      ),
    ).toBe(true);
  });

  test("シングルクォート内に [ ] を含む jq 引数の代入", () => {
    expect(
      isAssignmentOnly(`owner=$(gh repo view --json owner --jq '.owner.login')`),
    ).toBe(true);
  });

  test("配列代入 arr[0]=val は代入として認識しない", () => {
    expect(isAssignmentOnly("arr[0]=val")).toBe(false);
  });

  test("追記代入 FOO+=bar は代入として認識しない", () => {
    expect(isAssignmentOnly("FOO+=bar")).toBe(false);
  });

  test("代入後にコマンドが続く場合は false（クォート内危険コマンド含む）", () => {
    expect(
      isAssignmentOnly('FOO="$(rm -rf /)" git status'),
    ).toBe(false);
  });

  test("代入値の $() がクォート内に ) を含むケース", () => {
    expect(isAssignmentOnly('FOO=$(echo ")")')).toBe(true);
  });

  test("代入値内に複数の $() を含むケース", () => {
    expect(isAssignmentOnly('FOO=$(echo a)$(echo b)')).toBe(true);
  });

  test("値なし代入 FOO= も代入として認識する", () => {
    expect(isAssignmentOnly("FOO=")).toBe(true);
  });
});

describe("evaluateCommand - 変数代入", () => {
  const rules = loadRepoRules();

  test("VAR=$(allow されたコマンド) は allow になる", () => {
    const result = evaluateCommand(
      ["foo=$(git status)", "git status"],
      rules,
    );
    expect(result.decision).toBe("allow");
  });

  test("VAR=$(deny されたコマンド) は deny を保持する", () => {
    const result = evaluateCommand(
      ["foo=$(rm -rf /)", "rm -rf /"],
      rules,
    );
    expect(result.decision).toBe("deny");
  });

  test("代入のみでは unmatched にならない", () => {
    const result = evaluateCommand(["FOO=bar"], rules);
    expect(result.decision).toBe("allow");
  });

  test("cmd || true は allow になる", () => {
    const result = evaluateCommand(["git status", "true"], rules);
    expect(result.decision).toBe("allow");
  });

  test("cmd && false は allow になる", () => {
    const result = evaluateCommand(["git status", "false"], rules);
    expect(result.decision).toBe("allow");
  });

  test("クォート内危険コマンド付き代入: 内側 $(rm) が deny される", () => {
    const result = evaluateCommand(
      [`FOO=$(date ")$(rm -rf /)")`, "rm -rf /"],
      rules,
    );
    expect(result.decision).toBe("deny");
  });

  test("未定義コマンドは pass-through で allow になる", () => {
    const result = evaluateCommand(["some-undefined-cmd --flag"], rules);
    expect(result.decision).toBe("allow");
  });

  test("未定義コマンド + 既存 ask ルールの混在は ask になる", () => {
    const result = evaluateCommand(
      ["some-undefined-cmd", "pnpm install lodash"],
      rules,
    );
    expect(result.decision).toBe("ask");
  });

  test("未定義コマンド + deny ルールの混在は deny になる", () => {
    const result = evaluateCommand(
      ["some-undefined-cmd", "rm -rf /"],
      rules,
    );
    expect(result.decision).toBe("deny");
  });

  test("未定義コマンドに機密ファイルパスが含まれていれば deny", () => {
    const result = evaluateCommand(
      ["some-undefined-cmd ~/.ssh/id_rsa"],
      rules,
    );
    expect(result.decision).toBe("deny");
  });
});

// git -C <dir> <sub> は settings.json にルールが無く Claude Code 本体は自力で allow しない。
// hook が正規化して allow と判定したコマンドだけ hook 自身が allow を返せるよう、
// 全セグメントが「明示 allow かつ実行時の副作用 (ファイルへのリダイレクト / 展開 /
// env 前置 / 代入文) が無い」ときに限り hookApproved を立てる。
describe("evaluateCommand - git -C の hook allow (hookApproved)", () => {
  const rules = loadRepoRules();
  const evaluate = (command: string) =>
    evaluateCommand(parseShellCommands(command), rules, command);

  test.each([
    "git -C /repo status",
    "git -C /r status",
    "git -C '/r x' log --oneline",
    "git --no-pager -C /r log",
    'git -C /r commit -m "x"',
    "git -C /r status && git -C /s diff",
    "git -C /a status && git -C /b log --oneline",
    "git -C /repo log --oneline | head -5",
    "git -C /repo status 2>&1 | tail -5",
    "git -C /repo status 2>/dev/null",
    "(git -C /repo status)",
    "git -C ~/repo diff HEAD~1 HEAD^",
    // クォート内の > はリダイレクトではない (ダブルクォート内の ' もクォート開始ではない)
    'git -C /repo commit -m "a > b"',
    "git -C /repo commit -m \"it's > fine\"",
    // クォート内の非 ASCII 文字
    'git -C /repo commit -m "日本語のメッセージ"',
  ])("%s は hookApproved", (command) => {
    expect(evaluate(command)).toEqual({ decision: "allow", hookApproved: true });
  });

  // hook の allow は Claude Code 本体の確認を省略させるので、パーサ (shell-parser /
  // rule-matcher) が bash と同じ解釈をすると言い切れる字句だけで書かれたコマンドに限る。
  // 以下は bash では別コマンドが実行されるのに hook が 1 セグメントに吸収していた形
  // (コメント / 改行 / ANSI-C quoting 内の \')、およびそれと同じ字句クラスの入力。
  test.each([
    "git -C /r status #'\ntouch /tmp/pwned",
    "git -C /r status #'\npython3 -c 'import os'\n#'",
    "git -C /r status #'\nrm -rf /tmp/x\n#'",
    "git -C /r log $'\\'' ; touch /tmp/pwned #'",
    "git -C /r status\ntouch /tmp/pwned",
    "git -C /r status\rtouch /tmp/pwned",
    "git -C /r status # comment",
    // # を含む commit メッセージは保守化の許容トレードオフとして pass-through
    'git -C /r commit -m "fix #12"',
    // 対応の取れないクォート
    "git -C /r log 'abc",
    'git -C /r log "abc',
    // 展開・エスケープの字句はクォートの内外を問わず hook allow の対象外
    "git -C /repo log --format='%H $x'",
    "git -C /repo log --grep \\$x",
    "git -C /repo log --grep 'a\\b'",
    'git -C /repo log $"x"',
    // glob / brace は展開後の語が変わる
    "git -C /repo log *",
    "git -C /repo log {a,b}",
    // ダブルクォート内の ! (履歴展開)
    'git -C /repo commit -m "hi!"',
    // 非 ASCII の空白 (bash は区切りとして扱わない)
    "git -C /repo status x",
  ])("%j は hookApproved ではない (字句が保守的ホワイトリスト外)", (command) => {
    expect(evaluate(command)).not.toEqual({ decision: "allow", hookApproved: true });
  });

  // allow 一致がコマンド名のパス除去 (/tmp/evil/git → git) やクォート除去を経た候補由来の
  // 場合、実際に起動されるのは allow ルールが想定したコマンドとは別の実行ファイル。
  test.each([
    "./git -C . status",
    "/tmp/evil/git -C /r status",
    "/usr/bin/git -C /r status",
    "git -C /r status; /tmp/evil/echo hi",
    "git -C /r status && ./echo hi",
    "'git' -C /r status",
    'git -C /r status && "echo" hi',
  ])("%j は hookApproved ではない (コマンド名が bare でない)", (command) => {
    expect(evaluate(command)).not.toEqual({ decision: "allow", hookApproved: true });
  });

  test("生コマンドを渡さない呼び出しは hookApproved にしない", () => {
    expect(evaluateCommand(parseShellCommands("git -C /r status"), rules)).toEqual({
      decision: "allow",
      hookApproved: false,
    });
  });

  test.each([
    // -C を含まないコマンドは従来どおり本体の判定に委ねる
    "git status",
    "git status && git diff",
    // 未定義コマンドとの複合は全体を本体に委ねる
    "git -C /repo status && python script.py",
    // 正規化できても非 -C allow に無いサブコマンド
    "git -C . submodule foreach rm -rf / status",
    "git -C /x replace -d status",
    // ファイルへのリダイレクト / heredoc
    "git -C /repo status > /tmp/out",
    "git -C /repo log >> ~/.bashrc",
    "git -C /repo log <<EOF\nx\nEOF",
    // クォートを閉じた後 / エスケープしたクォートの後のリダイレクト
    "git -C /repo log --format='%H' > /tmp/out",
    "git -C /repo log \\' > /tmp/out",
    // env 前置 (GIT_EXEC_PATH 等で実行内容が変わりうる)
    "FOO=1 git -C /repo status",
    // -C 以外の引数の展開
    "git -C /repo log $(echo HEAD)",
    'git -C /repo commit -m "cost $X"',
    "git -C /repo log `echo HEAD`",
    // 代入文 (PATH 書き換え等で後続コマンドの実体が変わりうる)
    "PATH=/tmp/evil; git -C /repo status",
  ])("%s は allow だが hookApproved ではない", (command) => {
    expect(evaluate(command)).toEqual({ decision: "allow", hookApproved: false });
  });

  test("git -C /a status && git -C /b reset --hard は deny", () => {
    expect(evaluate("git -C /a status && git -C /b reset --hard").decision).toBe("deny");
  });

  test("git -C $(echo /x) status は ask", () => {
    expect(evaluate("git -C $(echo /x) status").decision).toBe("ask");
  });
});

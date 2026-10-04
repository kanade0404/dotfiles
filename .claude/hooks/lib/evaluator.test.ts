import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { evaluateCommand, isAssignmentOnly } from "./evaluator.ts";
import { loadRules } from "./rules.ts";
import { parseShellCommands } from "./shell-parser.ts";

const worktreeRoot = resolve(import.meta.dir, "..", "..", "..");

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
  const rules = loadRules(worktreeRoot);

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
  const rules = loadRules(worktreeRoot);
  const evaluate = (command: string) => evaluateCommand(parseShellCommands(command), rules);

  test.each([
    "git -C /repo status",
    "git -C /a status && git -C /b log --oneline",
    "git -C /repo log --oneline | head -5",
    "git -C /repo status 2>&1 | tail -5",
    "git -C /repo status 2>/dev/null",
    "(git -C /repo status)",
    // シングルクォート内の $ は展開ではない
    "git -C /repo log --format='%H $x'",
    // クォート内の > はリダイレクトではない (ダブルクォート内の ' もクォート開始ではない)
    'git -C /repo commit -m "a > b"',
    "git -C /repo commit -m \"it's > fine\"",
    // エスケープした $ は展開ではない
    "git -C /repo log --grep \\$x",
  ])("%s は hookApproved", (command) => {
    expect(evaluate(command)).toEqual({ decision: "allow", hookApproved: true });
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

import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { evaluateCommand, isAssignmentOnly } from "./evaluator.ts";
import { loadRules } from "./rules.ts";

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

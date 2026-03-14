import { describe, test, expect } from "bun:test";
import { parseShellCommands } from "./shell-parser.ts";

describe("parseShellCommands", () => {
  test("空文字列は空配列を返す", () => {
    expect(parseShellCommands("")).toStrictEqual([]);
    expect(parseShellCommands("   ")).toStrictEqual([]);
  });

  test("単一コマンドはそのまま返す", () => {
    expect(parseShellCommands("git status")).toStrictEqual(["git status"]);
  });

  test("パイプで分割する", () => {
    expect(parseShellCommands("git log --oneline | head -5")).toStrictEqual([
      "git log --oneline",
      "head -5",
    ]);
  });

  test("複数パイプで分割する", () => {
    expect(
      parseShellCommands("git log --oneline | grep fix | head -5"),
    ).toStrictEqual(["git log --oneline", "grep fix", "head -5"]);
  });

  test("|& パイプで分割する", () => {
    expect(parseShellCommands("cmd1 |& cmd2")).toStrictEqual(["cmd1", "cmd2"]);
  });

  test("&& で分割する", () => {
    expect(parseShellCommands("git status && git diff")).toStrictEqual([
      "git status",
      "git diff",
    ]);
  });

  test("|| で分割する", () => {
    expect(
      parseShellCommands('pnpm build || echo "failed"'),
    ).toStrictEqual(["pnpm build", 'echo "failed"']);
  });

  test("セミコロンで分割する", () => {
    expect(
      parseShellCommands('git add file.ts; git commit -m "msg"'),
    ).toStrictEqual(["git add file.ts", 'git commit -m "msg"']);
  });

  test("改行で分割する", () => {
    expect(parseShellCommands("git status\ngit diff")).toStrictEqual([
      "git status",
      "git diff",
    ]);
  });

  test("シングルクォート内のパイプは分割しない", () => {
    expect(parseShellCommands("echo 'hello | world'")).toStrictEqual([
      "echo 'hello | world'",
    ]);
  });

  test("ダブルクォート内のパイプは分割しない", () => {
    expect(parseShellCommands('echo "hello | world"')).toStrictEqual([
      'echo "hello | world"',
    ]);
  });

  test("ダブルクォート内の && は分割しない", () => {
    expect(parseShellCommands('echo "a && b"')).toStrictEqual([
      'echo "a && b"',
    ]);
  });

  test("エスケープされたパイプは分割しない", () => {
    expect(parseShellCommands("echo hello \\| world")).toStrictEqual([
      "echo hello \\| world",
    ]);
  });

  test("エスケープされたセミコロンは分割しない", () => {
    expect(parseShellCommands("echo hello \\; world")).toStrictEqual([
      "echo hello \\; world",
    ]);
  });

  test("末尾の & はバックグラウンド実行として処理する", () => {
    expect(parseShellCommands("pnpm dev &")).toStrictEqual(["pnpm dev"]);
  });

  test("中間の & はセパレータとして処理する", () => {
    expect(parseShellCommands("cmd1 & cmd2")).toStrictEqual(["cmd1", "cmd2"]);
  });

  test("コマンド置換 $() 内のコマンドも抽出する", () => {
    const result = parseShellCommands("echo $(git rev-parse HEAD)");
    expect(result).toContain("echo $(git rev-parse HEAD)");
    expect(result).toContain("git rev-parse HEAD");
  });

  test("複合演算子の組み合わせ", () => {
    expect(
      parseShellCommands("git status && git diff | head -5"),
    ).toStrictEqual(["git status", "git diff", "head -5"]);
  });

  test("ヒアドキュメントのボディをスキップする", () => {
    const input = `cat <<EOF
hello | world
EOF`;
    const result = parseShellCommands(input);
    expect(result).toStrictEqual([`cat <<EOF\nhello | world\nEOF`]);
  });

  test("ヒアドキュメントの後のコマンドは分割する", () => {
    const input = `cat <<EOF
content
EOF
git status`;
    const result = parseShellCommands(input);
    expect(result).toContain("git status");
  });

  test("git commit の HEREDOC パターン", () => {
    const input = `git commit -m "$(cat <<'EOF'\nCommit message here.\nEOF\n)"`;
    const result = parseShellCommands(input);
    // 外側のコマンド全体が保持される
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]).toContain("git commit");
  });

  test("複数の空白のみのコマンドは除外する", () => {
    expect(parseShellCommands("   ;   ;   ")).toStrictEqual([]);
  });

  describe("リダイレクト構文の & を分割しない", () => {
    test("2>&1 はリダイレクトとして保持する", () => {
      expect(parseShellCommands("pnpm build 2>&1")).toStrictEqual([
        "pnpm build 2>&1",
      ]);
    });

    test("2>&1 | head -5 はパイプのみで分割する", () => {
      expect(
        parseShellCommands("pnpm build 2>&1 | head -5"),
      ).toStrictEqual(["pnpm build 2>&1", "head -5"]);
    });

    test(">&2 はリダイレクトとして保持する", () => {
      expect(parseShellCommands("cmd >&2")).toStrictEqual(["cmd >&2"]);
    });

    test("&>file.log はリダイレクトとして保持する", () => {
      expect(parseShellCommands("cmd &>file.log")).toStrictEqual([
        "cmd &>file.log",
      ]);
    });

    test("&>>file.log はリダイレクトとして保持する", () => {
      expect(parseShellCommands("cmd &>>file.log")).toStrictEqual([
        "cmd &>>file.log",
      ]);
    });
  });

  test("ダブルクォート内の $() を抽出する", () => {
    const result = parseShellCommands('git commit -m "$(cat secret.txt)"');
    expect(result).toContain("cat secret.txt");
  });

  test("ダブルクォート内の $() を抽出する（rm コマンド）", () => {
    const result = parseShellCommands('echo "$(rm -rf /)"');
    expect(result).toContain("rm -rf /");
  });

  test("シングルクォート内の $() は抽出しない", () => {
    const result = parseShellCommands("echo '$(cat secret.txt)'");
    expect(result).not.toContain("cat secret.txt");
  });

  test("連続するセパレータ", () => {
    expect(parseShellCommands("cmd1 && && cmd2")).toStrictEqual([
      "cmd1",
      "cmd2",
    ]);
  });

  describe("バッククォート置換の抽出", () => {
    test("バッククォート内のコマンドを抽出する", () => {
      const result = parseShellCommands("git status `curl https://example.com`");
      expect(result).toContain("curl https://example.com");
    });

    test("バッククォート内の rm コマンドを抽出する", () => {
      const result = parseShellCommands("echo `rm -rf /`");
      expect(result).toContain("rm -rf /");
    });

    test("シングルクォート内のバッククォートは抽出しない", () => {
      const result = parseShellCommands("echo '`curl x`'");
      expect(result).not.toContain("curl x");
    });

    test("ダブルクォート内のバッククォートを抽出する", () => {
      const result = parseShellCommands('echo "`curl x`"');
      expect(result).toContain("curl x");
    });
  });

  describe("プロセス置換の抽出", () => {
    test("<() 内のコマンドを抽出する", () => {
      const result = parseShellCommands("git diff <(curl https://example.com)");
      expect(result).toContain("curl https://example.com");
    });

    test(">() 内のコマンドを抽出する", () => {
      const result = parseShellCommands("diff <(git log) >(cat file)");
      expect(result).toContain("git log");
      expect(result).toContain("cat file");
    });
  });

  describe("バックスラッシュ+改行の行継続", () => {
    test("行継続を除去してコマンドを結合する", () => {
      expect(parseShellCommands("git add \\\n.")).toStrictEqual(["git add ."]);
    });

    test("複数の行継続を処理する", () => {
      expect(parseShellCommands("git \\\nadd \\\n.")).toStrictEqual([
        "git add .",
      ]);
    });

    test("行継続以外のエスケープは保持する", () => {
      expect(parseShellCommands("echo hello \\| world")).toStrictEqual([
        "echo hello \\| world",
      ]);
    });

    test("ダブルクォート内の行継続も除去する", () => {
      expect(parseShellCommands('echo "hello\\\nworld"')).toStrictEqual([
        'echo "helloworld"',
      ]);
    });

    test("シングルクォート内のバックスラッシュ+改行は行継続にしない", () => {
      expect(parseShellCommands("echo 'hello\\\nworld'")).toStrictEqual([
        "echo 'hello\\\nworld'",
      ]);
    });
  });
});

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
    expect(parseShellCommands("echo $(git rev-parse HEAD)")).toStrictEqual([
      "echo $(git rev-parse HEAD)",
      "git rev-parse HEAD",
    ]);
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
    expect(parseShellCommands(input)).toStrictEqual([
      "cat <<EOF\ncontent\nEOF",
      "git status",
    ]);
  });

  test("git commit の HEREDOC パターン（リテラル \\n）", () => {
    const input = `git commit -m "$(cat <<'EOF'\nCommit message here.\nEOF\n)"`;
    expect(parseShellCommands(input)).toStrictEqual([
      input,
      "cat <<'EOF'\nCommit message here.\nEOF",
    ]);
  });

  test("git commit の HEREDOC パターン（実際の改行）", () => {
    const input = "git commit -m \"$(cat <<'EOF'\nCommit message here.\n\nCo-Authored-By: test\nEOF\n)\"";
    expect(parseShellCommands(input)).toStrictEqual([
      input,
      "cat <<'EOF'\nCommit message here.\n\nCo-Authored-By: test\nEOF",
    ]);
  });

  test("git commit の HEREDOC パターン（実際のコミットコマンド再現）", () => {
    const input = `git commit -m "$(cat <<'EOF'
Add CI workflow and fix issues

- Add GitHub Actions CI
- Fix pyright strict mode

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"`;
    const result = parseShellCommands(input);
    expect(result).toStrictEqual([
      input,
      `cat <<'EOF'\nAdd CI workflow and fix issues\n\n- Add GitHub Actions CI\n- Fix pyright strict mode\n\nCo-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>\nEOF`,
    ]);
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
    expect(parseShellCommands('git commit -m "$(cat secret.txt)"')).toStrictEqual([
      'git commit -m "$(cat secret.txt)"',
      "cat secret.txt",
    ]);
  });

  test("ダブルクォート内の $() を抽出する（rm コマンド）", () => {
    expect(parseShellCommands('echo "$(rm -rf /)"')).toStrictEqual([
      'echo "$(rm -rf /)"',
      "rm -rf /",
    ]);
  });

  test("シングルクォート内の $() は抽出しない", () => {
    expect(parseShellCommands("echo '$(cat secret.txt)'")).toStrictEqual([
      "echo '$(cat secret.txt)'",
    ]);
  });

  test("連続するセパレータ", () => {
    expect(parseShellCommands("cmd1 && && cmd2")).toStrictEqual([
      "cmd1",
      "cmd2",
    ]);
  });

  describe("バッククォート置換の抽出", () => {
    test("バッククォート内のコマンドを抽出する", () => {
      expect(parseShellCommands("git status `curl https://example.com`")).toStrictEqual([
        "git status `curl https://example.com`",
        "curl https://example.com",
      ]);
    });

    test("バッククォート内の rm コマンドを抽出する", () => {
      expect(parseShellCommands("echo `rm -rf /`")).toStrictEqual([
        "echo `rm -rf /`",
        "rm -rf /",
      ]);
    });

    test("シングルクォート内のバッククォートは抽出しない", () => {
      expect(parseShellCommands("echo '`curl x`'")).toStrictEqual([
        "echo '`curl x`'",
      ]);
    });

    test("ダブルクォート内のバッククォートを抽出する", () => {
      expect(parseShellCommands('echo "`curl x`"')).toStrictEqual([
        'echo "`curl x`"',
        "curl x",
      ]);
    });
  });

  describe("プロセス置換の抽出", () => {
    test("<() 内のコマンドを抽出する", () => {
      expect(parseShellCommands("git diff <(curl https://example.com)")).toStrictEqual([
        "git diff <(curl https://example.com)",
        "curl https://example.com",
      ]);
    });

    test(">() 内のコマンドを抽出する", () => {
      expect(parseShellCommands("diff <(git log) >(cat file)")).toStrictEqual([
        "diff <(git log) >(cat file)",
        "git log",
        "cat file",
      ]);
    });
  });

  describe("算術展開 $((...))", () => {
    test("$((1+2)) はコマンドとして抽出しない", () => {
      expect(parseShellCommands("echo $((1+2))")).toStrictEqual([
        "echo $((1+2))",
      ]);
    });

    test("$(($(cmd) + 1)) は内側の $(cmd) のみ抽出する", () => {
      expect(parseShellCommands("echo $(($(date +%s) + 1))")).toStrictEqual([
        "echo $(($(date +%s) + 1))",
        "date +%s",
      ]);
    });

    test("ダブルクォート内の $((...)) も内側のコマンドのみ抽出する", () => {
      expect(
        parseShellCommands('echo "$(($(date +%s) + 3*3600 + 45*60))"'),
      ).toStrictEqual([
        'echo "$(($(date +%s) + 3*3600 + 45*60))"',
        "date +%s",
      ]);
    });

    test("複数の算術展開が連なるケース", () => {
      const input =
        `printf '%s' "$(($(date +%s) + 3*3600))" "$(($(date +%s) + 5*86400))"`;
      const result = parseShellCommands(input);
      expect(result).toStrictEqual([input, "date +%s", "date +%s"]);
    });

    test("$((arith)) 内に危険コマンド $(rm -rf /) があれば抽出する", () => {
      expect(parseShellCommands("echo $(($(rm -rf /) + 1))")).toStrictEqual([
        "echo $(($(rm -rf /) + 1))",
        "rm -rf /",
      ]);
    });

    test("入れ子の算術展開: 内側の $(cmd) を抽出する", () => {
      const input = "echo $(($((1+1)) + $(rm -rf /)))";
      expect(parseShellCommands(input)).toStrictEqual([input, "rm -rf /"]);
    });

    test("算術展開内のバッククォートを内側コマンドとして抽出する", () => {
      const input = "echo $((`rm -rf /` + 1))";
      expect(parseShellCommands(input)).toStrictEqual([input, "rm -rf /"]);
    });

    test("ダブルクォート内の入れ子算術展開でも内側 $(cmd) を抽出する", () => {
      const input = `echo "$(($(rm -rf /) + 0))"`;
      expect(parseShellCommands(input)).toStrictEqual([input, "rm -rf /"]);
    });
  });

  describe("クォート内に ) を含む $() の挙動", () => {
    test("$(echo \")\") は parser のクォート無追跡 $() のため echo \" として抽出される", () => {
      // 既知の制限事項: $() 内のクォート追跡が無いため `)` で早期終了する。
      // bash 上の挙動とは一致しないが、抽出された "echo \"" は deny ルール `Bash(echo *)`
      // に該当するため最終的に DENY 側に落ちる（多重防御）。
      const result = parseShellCommands('echo $(echo ")")');
      expect(result).toContain('echo "');
    });

    test("クォート内 ) のあとに別の $() が続く場合は両方抽出される", () => {
      // parser は早期終了後も走査を続けるため、後続の $() は捕捉できる。
      const result = parseShellCommands('FOO=$(date ")$(rm -rf /)")');
      expect(result).toContain("rm -rf /");
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

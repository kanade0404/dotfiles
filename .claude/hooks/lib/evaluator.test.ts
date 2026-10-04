import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluateCommand, isAssignmentOnly, isPlainGitCCommand } from "./evaluator.ts";
import { patternToRegex } from "./rule-matcher.ts";
import { loadRules } from "./rules.ts";
import { createGitFixture, type GitFixture } from "./git-fixture.ts";
import type { Rule } from "./types.ts";
import { parseShellCommands } from "./shell-parser.ts";

const worktreeRoot = resolve(import.meta.dir, "..", "..", "..");

/**
 * リポジトリ同梱の settings.json だけからルールを読む。loadRules は $HOME 配下の
 * ~/.claude/settings.json 等もマージするので、HOME を空の一時ディレクトリに差し替えて
 * 個人設定の影響 (ローカルの allow / deny の有無でテスト結果が変わること) を排除する。
 * CLAUDE_PROJECT_DIR は worktree のルート (Claude Code がこのリポジトリで起動された状態)。
 */
function loadRepoRules() {
  const home = mkdtempSync(join(tmpdir(), "evaluator-test-"));
  try {
    return loadRules(worktreeRoot, { HOME: home, CLAUDE_PROJECT_DIR: worktreeRoot });
  } finally {
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
// hook 自身の allow は本体の確認を省略させるので、生コマンド全体が「単一の単純な
// `git [opt] -C <dir> [opt] <sub> [args]`」という厳密な正の文法 (evaluator.ts の
// isPlainGitCCommand) に完全一致し、正規化した `git <sub> ...` が非 -C allow に一致する
// ときだけ hookApproved を立てる。シェルの構文を部分的にモデル化して危険を除外する方式は
// 実行シェル (zsh) の構文の広さに追いつかず漏れが続いたため採らない。
// hook allow の文法 (isPlainGitCCommand) の字句単位の性質。PLAIN_CHARS 以外の文字は
// クォートの内外を問わず、word のどこに現れても文法外になる。
describe("isPlainGitCCommand", () => {
  test.each([
    "(", ")", "<", ">", "|", "&", ";", "^", "#", "$", "`", "\\", "*", "?", "[", "]",
    "{", "}", "!", "'", '"', "\t", "\n", "\r", " ", "é",
  ])("クォート外の %j を含む word は文法外", (ch) => {
    expect(isPlainGitCCommand(`git -C /r log a${ch}b`)).toBe(false);
  });

  test.each([
    "(", ")", "<", ">", "|", "&", ";", "^", "#", "$", "`", "\\", "*", "?", "[", "]",
    "{", "}", "!", "=", "~", "\t", "\n", "é",
  ])("シングル / ダブルクォート内の %j は文法外", (ch) => {
    expect(isPlainGitCCommand(`git -C /r log 'a${ch}b'`)).toBe(false);
    expect(isPlainGitCCommand(`git -C /r log "a${ch}b"`)).toBe(false);
  });

  // `=` / `~` は zsh で word 先頭 (と MAGIC_EQUAL_SUBST 下の `=` の直後) でだけ展開される
  test.each(["a=b", "--a=b", "-n=1", "a~1", "HEAD~"])("word 途中の %j は文法内", (word) => {
    expect(isPlainGitCCommand(`git -C /r log ${word}`)).toBe(true);
  });

  test.each(["=a", "~", "~a", "a==b", "a=~b", "-~", ".~", "/~", "a=(b)"])(
    "%j は文法外",
    (word) => {
      expect(isPlainGitCCommand(`git -C /r log ${word}`)).toBe(false);
    },
  );

  // zsh では `name1 name2 () body` が全ての name を関数として定義する (git 自体を再定義しうる)
  test("引数に () を含む形 (zsh の関数定義) は文法外", () => {
    expect(isPlainGitCCommand("git -C /r status () touch X")).toBe(false);
  });

  test("値を取る / 副作用のある global option は文法外", () => {
    expect(isPlainGitCCommand("git -c x=y -C /r log")).toBe(false);
    expect(isPlainGitCCommand("git -p -C /r log")).toBe(false);
    expect(isPlainGitCCommand("git -C /r --git-dir=/x log")).toBe(false);
  });
});

describe("evaluateCommand - git -C の hook allow (hookApproved)", () => {
  const rules = loadRepoRules();
  // cwd は一時リポジトリ main (sub/dir・"r x" を持ち、../wt が worktree)。
  // 文法外のケースでも -C の対象は存在する同一リポジトリ内のパスにして、
  // hookApproved にならない理由が文法だけになるようにする。
  let fx: GitFixture;
  beforeAll(() => { fx = createGitFixture(); });
  afterAll(() => { fx.cleanup(); });
  const evaluate = (command: string, cwd: string = fx.main) =>
    evaluateCommand(parseShellCommands(command), rules, command, cwd, {});
  const hookApproved = { decision: "allow", hookApproved: true } as const;
  const passThrough = { decision: "allow", hookApproved: false } as const;

  // -C の対象が cwd と別の git common dir を持つと、そのリポジトリの .git/config
  // (core.fsmonitor 等) や .git/hooks 経由で確認無しにコマンドを実行できる。
  // 文法と allow に一致しても hook allow せず pass-through にする。
  describe("-C の対象が cwd と同じリポジトリでなければ hookApproved にしない", () => {
    test.each([
      ["無関係なリポジトリ", (f: GitFixture) => `git -C ${f.other} status`],
      ["submodule 相当", () => "git -C sm status"],
      ["存在しないパス", () => "git -C no-such-dir status"],
      ["別リポジトリへのシンボリックリンク", () => "git -C link-other status"],
      ["git 管理外", (f: GitFixture) => `git -C ${f.plain} status`],
    ] as const)("%s", (_, command) => {
      expect(evaluate(command(fx))).toEqual(passThrough);
    });

    test("cwd が無い場合", () => {
      const command = `git -C ${fx.main} status`;
      expect(evaluateCommand(parseShellCommands(command), rules, command, undefined, {})).toEqual(
        passThrough,
      );
    });

    test("cwd が git 管理外の場合", () => {
      expect(evaluate(`git -C ${fx.main} status`, fx.plain)).toEqual(passThrough);
    });

    test("GIT_DIR が環境にある場合", () => {
      const command = "git -C sub status";
      expect(
        evaluateCommand(parseShellCommands(command), rules, command, fx.main, { GIT_DIR: "/x" }),
      ).toEqual(passThrough);
    });

    test("worktree からの main への -C は hookApproved", () => {
      expect(evaluate(`git -C ${fx.main} status`, fx.worktree)).toEqual(hookApproved);
    });
  });

  test.each([
    "git -C . status",
    "git -C sub status",
    "git -C sub log --oneline -5",
    "git -C 'r x' log --oneline",
    'git -C "r x" status',
    "git --no-pager -C sub log",
    "git -C sub --no-pager log",
    "git -P -C sub log",
    'git -C sub commit -m "fix bug"',
    "git -C sub commit -m 'fix: bug, see issue-12'",
    "git -C sub diff --stat",
    // `=` は word の途中 (英数字 / `-` の直後) なら zsh の `=cmd` 展開にならない
    "git -C sub log --format=%H",
    "git -C sub log --since=2.weeks --author=foo@example.com",
    // `~` は word の途中 (英数字の直後) なら zsh のチルダ展開にならない
    "git -C sub diff HEAD~1 HEAD",
    "git -C ../wt status --short",
  ])("%j は hookApproved", (command) => {
    expect(evaluate(command)).toEqual(hookApproved);
  });

  // 実行シェルは zsh (Claude Code の Bash tool は `zsh -c '... eval <cmd>'` で実行する)。
  // 以下はいずれも zsh で git 以外のコマンドが実行される・git の実行内容が変わる・
  // ファイルに書き込む形、またはそれと同じ字句クラスの入力。複合コマンドは hook allow
  // しない (pass-through で本体の判定に委ねる)。
  test.each([
    // 関数定義で allow 済みコマンド名を再定義する (zsh の `name () cmd` 形)
    "echo () (touch X); git -C sub status; echo",
    "git -C sub status; sleep () (touch X); sleep 0",
    "git -C sub status; echo () touch X; echo",
    // zsh の `=(...)` プロセス置換 / `=cmd` 展開
    "git -C sub status =(touch X)",
    "git -C sub status; echo =(touch X)",
    "git -C =x status",
    "git -C sub log =ls",
    "git -C sub log --format==ls",
    // `time` / `env` / `command` 等の前置と env 代入
    "time GIT_TRACE=X git -C sub status",
    "time PATH=/tmp/evil git -C sub status",
    "time env GIT_TRACE=X git -C sub status",
    "time git -C sub status",
    "command git -C sub status",
    "FOO=1 git -C sub status",
    "env git -C sub status",
    "exec git -C sub status",
    "nice git -C sub status",
    // fd 複製の後ろにファイル名が続く形 (`>&1mk` は 1mk への書き込み)
    "git -C sub log -1 >&1mk",
    "git -C sub log -1 2>&1 >&2zz",
    "git -C sub log >&1mk",
    "git -C sub status 2>/dev/null",
    "git -C sub status > /tmp/out",
    // `#` コメント / 改行 / ANSI-C quoting
    "git -C sub status #'\ntouch /tmp/pwned",
    "git -C sub status #'\npython3 -c 'import os'\n#'",
    "git -C sub log $'\\'' ; touch /tmp/pwned #'",
    "git -C sub status\ntouch /tmp/pwned",
    "git -C sub status\n",
    "git -C sub status\rtouch /tmp/pwned",
    "git -C sub status # comment",
    'git -C sub commit -m "fix #12"',
    // パス付き / クォート付きのコマンド名
    "./git -C . status",
    "/tmp/evil/git -C sub status",
    "/usr/bin/git -C sub status",
    "'git' -C sub status",
    "git -C sub status; /tmp/evil/echo hi",
    // 複合コマンド・サブシェル・パイプ
    "git -C a status && git -C b diff",
    "git -C sub status && git -C sub diff",
    "git -C sub status; git -C sub diff",
    "git -C sub log --oneline | head -5",
    "git -C sub status &",
    "(git -C sub status)",
    "{ git -C sub status; }",
    // word 先頭の `~` (チルダ展開) / `=` の後の `~` (MAGIC_EQUAL_SUBST)
    "git -C ~/x status",
    "git -C sub log ~",
    "git -C sub log --x=~/y",
    // 展開・エスケープ・glob・brace・履歴展開・非 ASCII
    "git -C sub log $(echo HEAD)",
    "git -C sub log `echo HEAD`",
    'git -C sub commit -m "cost $X"',
    "git -C sub log --grep \\$x",
    "git -C sub log *",
    "git -C sub log {a,b}",
    "git -C sub diff HEAD^",
    'git -C sub commit -m "hi!"',
    'git -C sub commit -m "日本語のメッセージ"',
    'git -C sub commit -m "a > b"',
    "git -C sub status x",
    "git -C sub status　x",
    // クォートの連結 (zsh の RC_QUOTES では `''` が `'` になる) / 対応の取れないクォート
    "git -C sub log 'a''b'",
    'git -C sub log "a"b',
    "git -C sub log 'abc",
    // 空白類の区切り・前後の空白
    "git\t-C sub status",
    " git -C sub status",
    "git -C sub status ",
    // -C の形
    "git -Csub status",
    "git -C sub -C sub status",
    "git -c core.pager=x -C sub log",
    // クォートしたサブコマンド
    "git -C sub 'status'",
  ])("%j は hookApproved ではない", (command) => {
    expect(evaluate(command)).not.toEqual(hookApproved);
  });

  // hook allow の根拠は「正規化した `git <sub> ...` が非 -C allow にサブコマンド位置で
  // 一致した」ことだけ。生コマンドが (ユーザが足した緩い -C ルール等に) 一致しても足りない。
  test("生コマンドが緩い -C allow に一致しても、正規化した git <sub> が allow に無ければ hookApproved にしない", () => {
    const loose: Rule[] = [
      { category: "allow", pattern: "Bash(git -C *)", regex: patternToRegex("git -C *") },
    ];
    const command = "git -C sub replace -d x";
    expect(evaluateCommand(parseShellCommands(command), loose, command, fx.main, {})).toEqual({
      decision: "allow",
      hookApproved: false,
    });
  });

  test("シングルクォート内の $ (リテラル) も文法外として扱う", () => {
    expect(evaluate("git -C sub log '$x'")).not.toEqual(hookApproved);
  });

  test("生コマンドを渡さない呼び出しは hookApproved にしない", () => {
    expect(evaluateCommand(parseShellCommands("git -C sub status"), rules)).toEqual({
      decision: "allow",
      hookApproved: false,
    });
  });

  // 文法に一致しない allow は従来どおり pass-through (hookApproved: false) のまま
  test.each([
    "git status",
    "git status && git diff",
    "git -C sub status && git -C sub diff",
    "git -C . status && python script.py",
    "git -C . log --oneline | head -5",
    // 文法には一致しても正規化した `git <sub>` が非 -C allow に無いサブコマンド
    "git -C . submodule foreach rm -rf / status",
    "git -C . replace -d status",
    "git -C . status > /tmp/out",
    "FOO=1 git -C . status",
    "git -C . log $(echo HEAD)",
    "PATH=/tmp/evil; git -C . status",
  ])("%j は allow だが hookApproved ではない", (command) => {
    expect(evaluate(command)).toEqual({ decision: "allow", hookApproved: false });
  });

  // deny / ask の判定は文法による hook allow の限定とは独立に従来どおり
  test.each([
    "git -C /r reset --hard",
    "git -C /r push --force",
    "git -C /r commit --no-verify -m x",
    "git -C /r status; rm -rf x",
    "git -C /a status && git -C /b reset --hard",
  ])("%j は deny", (command) => {
    expect(evaluate(command).decision).toBe("deny");
  });

  test("git -C $(echo /x) status は ask", () => {
    expect(evaluate("git -C $(echo /x) status").decision).toBe("ask");
  });
});

// ユーザ設定 (~/.claude/settings.json 等) の ask ルールは Claude Code 本体ではプレフィックス
// 一致なので `git -C <dir> commit ...` には効かない。-C 版で ask を適用できるのは hook だけ
// なので、正規化した `git <sub> ...` に対しても deny > ask > allow の順で判定する。
describe("evaluateCommand - git -C と ask ルール", () => {
  const askRule = (p: string): Rule => ({ category: "ask", pattern: `Bash(${p})`, regex: patternToRegex(p) });
  const rules = [...loadRepoRules(), askRule("git push *"), askRule("git commit *")];
  const evaluate = (command: string) =>
    evaluateCommand(parseShellCommands(command), rules, command);

  test.each([
    'git -C /r commit -m "fix bug"',
    "git -C /r push origin main",
    "git --no-pager -C /r commit -m x",
  ])("非 -C allow と ask の両方に一致する %j は ask", (command) => {
    expect(evaluate(command).decision).toBe("ask");
  });

  test("ask に一致しない git -C /r status は ask にならない", () => {
    expect(evaluate("git -C /r status").decision).toBe("allow");
  });

  test("deny は ask より優先: git -C /r push --force は deny", () => {
    expect(evaluate("git -C /r push --force").decision).toBe("deny");
  });
});

// hook の allow は Claude Code 本体の確認を省略させるので、その根拠になる allow ルールは
// 本体が実際に読む設定 (~/.claude/settings.json と、CLAUDE_PROJECT_DIR = セッションを
// 開始したプロジェクトルートの .claude/settings.json / settings.local.json) に限る。
// .codex/* や hook 入力の cwd 基準の .claude/* はリポジトリ内容 (エージェントが書ける /
// clone 元が仕込める) で、本体は読まないので allow の根拠にしない (deny / ask には使う)。
describe("evaluateCommand - hook allow の根拠になる設定ファイル", () => {
  let fx: GitFixture;
  let home: string;
  beforeAll(() => {
    fx = createGitFixture();
    home = mkdtempSync(join(tmpdir(), "evaluator-sources-"));
  });
  afterAll(() => {
    fx.cleanup();
    rmSync(home, { recursive: true, force: true });
  });
  afterEach(() => {
    for (const dir of [join(home, ".claude"), join(fx.main, ".codex"), join(fx.main, ".claude"), join(fx.main, "sub", ".claude")]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeSettings(path: string, permissions: Record<string, string[]>) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ permissions }));
  }

  function evaluate(command: string, opts: { cwd?: string; env?: Record<string, string> } = {}) {
    const cwd = opts.cwd ?? fx.main;
    const env = opts.env ?? { HOME: home, CLAUDE_PROJECT_DIR: fx.main };
    return evaluateCommand(parseShellCommands(command), loadRules(cwd, env), command, cwd, {});
  }

  const hookApproved = { decision: "allow", hookApproved: true } as const;
  const passThrough = { decision: "allow", hookApproved: false } as const;
  const submoduleAllow = { allow: ["Bash(git submodule *)"] };

  test.each([
    [".codex/settings.json", () => join(fx.main, ".codex", "settings.json")],
    [".codex/settings.local.json", () => join(fx.main, ".codex", "settings.local.json")],
  ] as const)("%s の allow は hookApproved の根拠にしない", (_, path) => {
    writeSettings(path(), submoduleAllow);
    expect(evaluate("git -C . submodule foreach touch pwned")).toEqual(passThrough);
  });

  test("cwd (サブディレクトリ) の .claude/settings.json の allow は hookApproved の根拠にしない", () => {
    writeSettings(join(fx.main, "sub", ".claude", "settings.json"), submoduleAllow);
    expect(evaluate("git -C . submodule foreach touch pwned", { cwd: join(fx.main, "sub") })).toEqual(passThrough);
  });

  test.each([
    ["settings.json", "settings.json"],
    ["settings.local.json", "settings.local.json"],
  ])("プロジェクトルート (CLAUDE_PROJECT_DIR) の .claude/%s の allow は hookApproved", (_, file) => {
    writeSettings(join(fx.main, ".claude", file), submoduleAllow);
    expect(evaluate("git -C . submodule status")).toEqual(hookApproved);
  });

  test("cwd がサブディレクトリでもプロジェクトルートの .claude/settings.json の allow は hookApproved", () => {
    writeSettings(join(fx.main, ".claude", "settings.json"), submoduleAllow);
    expect(evaluate("git -C . submodule status", { cwd: join(fx.main, "sub") })).toEqual(hookApproved);
  });

  test("~/.claude/settings.json の allow は hookApproved", () => {
    writeSettings(join(home, ".claude", "settings.json"), submoduleAllow);
    expect(evaluate("git -C . submodule status")).toEqual(hookApproved);
  });

  // CLAUDE_PROJECT_DIR は Claude Code が hook に渡す。無い / 相対 / 存在しないなら
  // 本体がどの設定を読んでいるか分からないので、どのルールも hook allow の根拠にしない。
  test.each([
    ["未設定", (h: string) => ({ HOME: h })],
    ["相対パス", (h: string) => ({ HOME: h, CLAUDE_PROJECT_DIR: "main" })],
    ["存在しないパス", (h: string) => ({ HOME: h, CLAUDE_PROJECT_DIR: join(h, "no-such-dir") })],
  ] as const)("CLAUDE_PROJECT_DIR が%sなら hookApproved にしない", (_, env) => {
    writeSettings(join(home, ".claude", "settings.json"), submoduleAllow);
    writeSettings(join(fx.main, ".claude", "settings.json"), submoduleAllow);
    expect(evaluate("git -C . submodule status", { env: env(home) })).toEqual(passThrough);
  });

  // CLAUDE_CONFIG_DIR があると本体はユーザ設定を ~/.claude ではなくそこから読む
  test("CLAUDE_CONFIG_DIR があれば ~/.claude/settings.json の allow は hookApproved の根拠にしない", () => {
    writeSettings(join(home, ".claude", "settings.json"), submoduleAllow);
    expect(
      evaluate("git -C . submodule status", {
        env: { HOME: home, CLAUDE_PROJECT_DIR: fx.main, CLAUDE_CONFIG_DIR: join(home, "elsewhere") },
      }),
    ).toEqual(passThrough);
  });

  // deny / ask は厳しくなる方向なので、本体が読まない設定由来でも従来どおり効かせる
  test(".codex/settings.json の deny は git -C の正規化候補にも効く", () => {
    writeSettings(join(home, ".claude", "settings.json"), { allow: ["Bash(git status *)"] });
    writeSettings(join(fx.main, ".codex", "settings.json"), { deny: ["Bash(git status *)"] });
    expect(evaluate("git -C . status").decision).toBe("deny");
  });

  test("cwd の .claude/settings.json の ask は git -C の正規化候補にも効く", () => {
    writeSettings(join(home, ".claude", "settings.json"), submoduleAllow);
    writeSettings(join(fx.main, "sub", ".claude", "settings.json"), { ask: ["Bash(git submodule *)"] });
    expect(evaluate("git -C . submodule status", { cwd: join(fx.main, "sub") }).decision).toBe("ask");
  });
});

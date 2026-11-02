import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluateCommand, isAssignmentOnly, isPlainGitCCommand } from "./evaluator.ts";
import { patternToRegex } from "./rule-matcher.ts";
import { defaultManagedSettingsSources, loadRules, type ManagedSettingsSources } from "./rules.ts";
import { createGitFixture, type GitFixture } from "./git-fixture.ts";
import type { Rule } from "./types.ts";
import { parseShellCommands } from "./shell-parser.ts";

const worktreeRoot = resolve(import.meta.dir, "..", "..", "..");

/**
 * リポジトリ同梱の settings.json だけからルールを読む。HOME を一時ディレクトリに差し替え、
 * その ~/.claude/settings.json にリポジトリの .claude/settings.json をコピーする (hook allow の
 * 根拠になるのはユーザ設定の allow だけ。install.sh が配る状態に相当)。個人の設定
 * (実 HOME)・マシンの managed settings・main checkout の settings.local.json に結果を左右されない
 * よう、cwd と CLAUDE_PROJECT_DIR も git 管理外の空の一時ディレクトリにする。
 */
function loadRepoRules() {
  const base = mkdtempSync(join(tmpdir(), "evaluator-test-"));
  try {
    const home = join(base, "home");
    const project = join(base, "project");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(project);
    copyFileSync(join(worktreeRoot, ".claude", "settings.json"), join(home, ".claude", "settings.json"));
    // managed settings はマシンの設定に依存させない (存在しないパスを渡す)
    const noManaged = { file: join(base, "managed-settings.json"), dropInDir: join(base, "managed-settings.d"), opaque: [] };
    return loadRules(project, { HOME: home, CLAUDE_PROJECT_DIR: project }, noManaged);
  } finally {
    rmSync(base, { recursive: true, force: true });
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
    "{", "}", "!", "'", '"', "\t", "\n", "\r", "\u00a0", "é",
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

  // -C の位置だけは単純な変数参照を許す (ADR 0004)。ダブルクォート内は値によらず 1 語、
  // クォート無しは参照 1 個だけ (同じコマンド内の代入の条件は hookAllowSegments が見る)
  test.each(["$R", "${R}", '"$R"', '"${R}"', '"${R}/sub"', '"$HOME/x y"'])("-C の %j は文法内", (dir) => {
    expect(isPlainGitCCommand(`git -C ${dir} status`)).toBe(true);
  });

  test.each(["$R/sub", "${R}x", "$R$S", "${R:-x}", "$1", "$@", '"$1"', "'$R'", "$(pwd)", '"$(pwd)"', "${R}{a,b}"])(
    "-C の %j は文法外",
    (dir) => {
      expect(isPlainGitCCommand(`git -C ${dir} status`)).toBe(false);
    },
  );

  test("-C 以外の位置の変数参照は文法外", () => {
    expect(isPlainGitCCommand("git -C /r log $R")).toBe(false);
    expect(isPlainGitCCommand('git -C /r log "$R"')).toBe(false);
  });

  // `"$aaaa…"` の参照の名前の長さの選び方が参照ごとに複数あると、一致しない入力で分け方を
  // 全て試し、指数的に遅くなる (修正前は参照 6 個で約 0.5 秒かかり、JSC の上限で打ち切られていた)
  describe("変数参照を多数並べた入力でもすぐに終わる (ReDoS)", () => {
    const refs = "$aaaaaaaaaaaaaaaa".repeat(30);
    const rules = loadRepoRules();
    test.each([
      `git -C "${refs}" status > /tmp/x`,
      `git -C "${refs}" status; git -C "${refs}" log >`,
      `R=/x; git -C "${refs}x" status && echo "${refs}"`,
      `git -C "${refs}$" status`,
    ])("%#", (command) => {
      const start = performance.now();
      expect(isPlainGitCCommand(command)).toBe(false);
      expect(evaluateCommand(parseShellCommands(command), rules, command, {})).not.toEqual({
        decision: "allow",
        hookApproved: true,
      });
      expect(performance.now() - start).toBeLessThan(100);
    });
  });
});

describe("evaluateCommand - git -C の hook allow (hookApproved)", () => {
  const rules = loadRepoRules();
  /** 代入してよい変数名の判定に使う環境 (hook の process.env に相当) */
  const env = { PATH: "/usr/bin:/bin", HOME: "/Users/x", PAGER: "less" };
  const evaluate = (command: string, e: Record<string, string> = env) =>
    evaluateCommand(parseShellCommands(command), rules, command, e);
  const hookApproved = { decision: "allow", hookApproved: true } as const;
  const passThrough = { decision: "allow", hookApproved: false } as const;

  // `git -C <dir> <sub>` は `git <sub>` と同じ扱いにする (ADR 0004)。-C の対象が cwd と別の
  // リポジトリか・存在するかは判定に使わない。別リポジトリの .git/config や .git/hooks が
  // 確認無しに実行されうることは受け入れたトレードオフ。
  describe("-C の対象ディレクトリによらず hookApproved", () => {
    test.each([
      "git -C /Users/kanade0404/orca/workspaces/skills/pinniped diff --stat",
      "git -C ../other-repo status",
      "git -C no-such-dir status",
      "git -C /tmp/agent-made-repo log --oneline",
    ])("%j", (command) => {
      expect(evaluate(command)).toEqual(hookApproved);
    });

    // 環境の GIT_DIR 等は非 -C の `git status` (本体が allow で自動許可する) にも同じく効くので、
    // -C 版だけ止める理由にしない
    test("GIT_DIR が環境にあっても hookApproved", () => {
      expect(evaluate("git -C sub status", { ...env, GIT_DIR: "/x" })).toEqual(hookApproved);
    });
  });

  // -C の引数の単純な変数参照。ダブルクォート内は値によらず 1 語。クォート無しは値が空なら
  // 語ごと消え (zsh / bash)、bash では空白で分割されるので、同じコマンド内で必ず実行される
  // 空でない・空白を含まない代入があり、さらに値が入った形 (`git <sub> ...`) と語が消えた形
  // (`git -C <次の語> ...`) の両方が allow に一致し deny / ask に当たらないときだけ hookApproved にする。
  describe("-C の変数参照", () => {
    test.each([
      'git -C "$R" diff --stat',
      'git -C "${R}" status',
      'git -C "${R}/sub" log --oneline',
      'R=/Users/kanade0404/orca/workspaces/skills/pinniped; git -C "$R" diff --stat',
      'R=/x; S=/y; git -C "$R" status; git -C "${S}/sub" diff',
      // クォートした参照は値に空白があっても 1 語
      "R='/x y'; git -C \"$R\" status",
      // 語が消えた形は `git -C --no-pager log` (`--no-pager` のディレクトリで git log) で、これも allow
      "R=/x; git -C $R --no-pager log",
      "R=/x; git -C ${R} --no-pager log",
      "R=/x && git -C $R --no-pager log",
      "R=/x; git -C $R --no-pager log || true",
      "R=/x || true; git -C $R --no-pager log",
      "R='/x'; git -C $R --no-pager log",
      // 語が消えた形は `git -C status log` (`git log`) で、値が入った形 `git status log` も allow
      "R=/x; git -C $R status log",
    ])("%j は hookApproved", (command) => {
      expect(evaluate(command)).toEqual(hookApproved);
    });

    test.each([
      // 代入が無い (値が空なら `-C` が次の語を取る。`git -C diff --stat` になる)
      "git -C $R diff --stat",
      "git -C ${R} status",
      "git -C $R --no-pager log",
      // 語が消えた形が allow に一致しない (`git -C diff --stat` / `git -C status` / `git -C log --oneline`)
      "R=/Users/kanade0404/orca/workspaces/skills/pinniped; git -C $R diff --stat",
      "R=/x; git -C $R status",
      "R=/x; git -C ${R} log --oneline",
      // 語が消えた形が allow に無いサブコマンドになる (`git -C diff replace -d x` は `git replace -d x`)
      "R=/x; git -C $R diff replace -d x",
      "R=/x; git -C $R diff submodule foreach touch x",
      // 代入が必ず実行されるとは限らない / サブシェルで実行される
      "false && R=/x; git -C $R --no-pager log",
      "true || R=/x; git -C $R --no-pager log",
      "R=/x | git -C $R --no-pager log",
      "echo x | R=/x; git -C $R --no-pager log",
      // 代入の後に参照より前の位置で空にされうる / 値が空・空白を含む (bash で分割される)
      "R=/x; R=; git -C $R --no-pager log",
      "R=/x; false && R= ; git -C $R --no-pager log",
      "R=; git -C $R --no-pager log",
      "R='/x y'; git -C $R --no-pager log",
      "R='/x status'; git -C $R --no-pager log",
      // 参照より後の代入
      "git -C $R --no-pager log; R=/x",
      // 環境にある変数は子プロセスに渡り、代入で git の挙動を変えうる
      "PAGER=/x; git -C $PAGER --no-pager log",
      // クォートしない連結・特殊パラメータ・既定値付きの展開
      "R=/x; git -C $R/sub status",
      "git -C $1 status",
      "git -C ${R:-/x} status",
    ])("%j は hookApproved ではない", (command) => {
      expect(evaluate(command)).not.toEqual(hookApproved);
    });

    test("環境に同名の変数 (大小文字違いを含む) があれば代入を受け付けない", () => {
      expect(evaluate("R=/x; git -C $R --no-pager log", { ...env, R: "/y" })).toEqual(passThrough);
      expect(evaluate("r=/x; git -C $r --no-pager log", { ...env, R: "/y" })).toEqual(passThrough);
      expect(evaluate('R=/x; git -C "$R" status', { ...env, R: "/y" })).toEqual(passThrough);
    });

    // 代入しても値が入らない変数 (bash の FUNCNAME、zsh の funcstack 等) と、bash でコマンドの解決を
    // 変える変数。語が消えた形も allow になる形 (`--no-pager log`) でも、名前で弾く
    test.each([
      "FUNCNAME", "funcstack", "functrace", "funcfiletrace", "funcsourcetrace",
      "EXECIGNORE", "FIGNORE", "HOSTFILE", "BASH_COMPAT",
    ])("特殊な変数 %s への代入は hookApproved ではない", (name) => {
      expect(evaluate(`${name}=/x; git -C $${name} --no-pager log`)).toEqual(passThrough);
      expect(evaluate(`${name}=/x; git -C "$${name}" status`)).toEqual(passThrough);
    });

    // 代入できるのは同じコマンド内で `git -C` の引数として参照される変数だけ。それ以外の変数は
    // export 済みかどうかを hook から確かめきれない (Bash tool のシェルだけが読む export がある)
    test.each([
      "TFE_ADDRESS=https://evil.example; git -C . status && make plan",
      "TFE_ADDRESS=https://evil.example; git -C . status",
      'R=/x; S=/y; git -C "$R" status',
      "S=/y; git -C $R --no-pager log",
      "R=/x; echo ok; git -C . status",
    ])("%j は hookApproved ではない", (command) => {
      expect(evaluate(command)).toEqual(passThrough);
    });

    describe("CLAUDE_ENV_FILE", () => {
      let dir: string;
      beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "evaluator-env-file-"));
      });
      afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
      });

      test("export されている変数 (大小文字違いを含む) への代入は hookApproved ではない", () => {
        const file = join(dir, "env.sh");
        writeFileSync(file, "export GOPATH=/Users/x/go\nexport R='/y'\ntypeset -x S\n");
        const withFile = { ...env, CLAUDE_ENV_FILE: file };
        expect(evaluate('R=/x; git -C "$R" status', withFile)).toEqual(passThrough);
        expect(evaluate('r=/x; git -C "$r" status', withFile)).toEqual(passThrough);
        expect(evaluate('S=/x; git -C "$S" status', withFile)).toEqual(passThrough);
        expect(evaluate('T=/x; git -C "$T" status', withFile)).toEqual(hookApproved);
      });

      test("ファイルが存在しない場合は無視する", () => {
        const withMissing = { ...env, CLAUDE_ENV_FILE: join(dir, "missing.sh") };
        expect(evaluate('R=/x; git -C "$R" status', withMissing)).toEqual(hookApproved);
      });
    });
  });

  // 複合コマンドは、生コマンド全体が「単純コマンド・代入を ; && || | で繋いだもの」の正の文法に
  // 一致し、代入以外の全セグメントが allow ルールに肯定的に一致するときだけ hookApproved。
  describe("複合コマンド", () => {
    test.each([
      "git -C /a status && git -C /b diff",
      "git -C sub status; git -C sub diff",
      "git -C sub log --oneline | head -5",
      "git -C sub log --oneline|head -5",
      "git status && git -C /b diff",
      "git -C /a status; echo done",
      "git -C /a status || true",
      "git -C /a diff --stat | wc -l",
      "pwd; git -C /a status",
      "git -C /a status && sleep 1 && git -C /a log -1",
    ])("%j は hookApproved", (command) => {
      expect(evaluate(command)).toEqual(hookApproved);
    });

    test.each([
      // どのルールにも一致しないセグメント (matchCommand が null) を含む
      "git -C /a status; some-undefined-cmd",
      "git -C /a status && python3 script.py",
      "git -C . status && git -C . submodule foreach touch x",
      // -C の無いコマンドだけなら本体が自分で判定できるので hook allow しない
      "git status && git diff",
      "echo a; echo b",
      // 組み込みコマンド (シェルの状態を変えうる) とラッパー
      "git -C /a status; printf x",
      "printf -v PATH /tmp/evil; git -C . status",
      "git -C /a status; command touch x",
      "git -C /a status; nice make",
      "git -C /a status; time make",
      "git -C /a status; exec make",
      // 危険な変数への代入
      "PATH=/tmp/evil; git -C . status",
      "path=/tmp/evil; git -C . status",
      "HOME=/tmp/x; git -C . status",
      "IFS=/; git -C . status",
      "GIT_CONFIG_GLOBAL=/tmp/x; git -C . status",
      "LD_PRELOAD=/tmp/x.so; git -C . status",
      // 代入の前置 (一時環境変数)
      "R=/x git -C . status",
      // 文法外の区切り・字句 (改行・バックグラウンド・|&・ヒアドキュメント・リダイレクト)
      "git -C . status\ngit -C . diff",
      "git -C . status & git -C . diff",
      "git -C . status |& head",
      "git -C . status;",
      "; git -C . status",
      "git -C . status ;; git -C . diff",
      "git -C . log | head -5 > /tmp/out",
      "/usr/bin/python3 - <<'EOF'\nprint(1)\nEOF\nR=/x; git -C $R diff --stat",
      // -C 以外の位置の展開
      "R=/x; echo $R; git -C . status",
      "git -C . log \"$R\"",
    ])("%j は hookApproved ではない", (command) => {
      expect(evaluate(command)).not.toEqual(hookApproved);
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
  // 以下はいずれも zsh で allow ルールに一致しないコマンドが実行される・git の実行内容が変わる・
  // ファイルに書き込む形、またはそれと同じ字句クラスの入力。hook allow しない
  // (pass-through で本体の判定に委ねる)。
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
    "git -C sub status; ./echo hi",
    // バックグラウンド・サブシェル・ブレースグループ
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
    "git -C sub status\u00a0x", // NBSP
    "git -C sub status\u3000x", // 全角スペース
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
    expect(evaluateCommand(parseShellCommands(command), loose, command, {})).toEqual({
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

  // 文法または allow に一致しない allow は従来どおり pass-through (hookApproved: false) のまま
  test.each([
    "git status",
    "git status && git diff",
    "git -C . status && python script.py",
    // 文法には一致しても正規化した `git <sub>` が非 -C allow に無いサブコマンド
    "git -C . submodule foreach rm -rf / status",
    "git -C . replace -d status",
    "git -C . status > /tmp/out",
    "FOO=1 git -C . status",
    "git -C . log $(echo HEAD)",
    "PATH=/tmp/evil; git -C . status",
    "git -C $R diff --stat",
  ])("%j は allow だが hookApproved ではない", (command) => {
    expect(evaluate(command)).toEqual({ decision: "allow", hookApproved: false });
  });

  // 正規化後の deny / ask は、-C の対象・変数参照・複合コマンドの hook allow とは独立に従来どおり効く
  test.each([
    "git -C /r reset --hard",
    "git -C /other reset --hard",
    "git -C /r push --force",
    "git -C $R push --force",
    'git -C "$R" push --force',
    "R=/x; git -C $R push --force",
    "git -C ${R} reset --hard",
    "git -C /r commit --no-verify -m x",
    "git -C $R commit --no-verify -m x",
    "git -C /r status; rm -rf x",
    "git -C /a status && git -C /b reset --hard",
    "git -C /a status && git -C $R reset --hard",
    "git -C /a status | git -C /b push -f origin main",
    // 付け替え時だけ危険なサブコマンド (dangerousWhenRedirected)
    "git -C $R rm -r .",
    "git -C /other branch -d feature",
    // R が空だと `git -C status rm -r .` (rm を status で実行) になる
    "git -C $EMPTY status rm -r .",
    // 機密パス
    "git -C $R log -- ~/.ssh/id_rsa",
    "git -C /other diff .env",
  ])("%j は deny", (command) => {
    expect(evaluate(command).decision).toBe("deny");
  });

  // 変数参照以外の展開を含む -C の引数は、展開後の語数が変わりうるので ask
  test.each([
    "git -C $(echo /x) status",
    "git -C `pwd` status",
    'git -C "$(pwd)" status',
    "git -C {a,b} status",
    "git -C ${R}{a,b} status",
    "git -C * status",
    "git -C $R* status",
    "git -C ${R:-/x} status",
    "git -C $1 status",
    'git -C "$@" status',
  ])("%j は ask", (command) => {
    expect(evaluate(command).decision).toBe("ask");
  });
});

// ユーザ設定 (~/.claude/settings.json 等) の ask ルールは Claude Code 本体ではプレフィックス
// 一致なので `git -C <dir> commit ...` には効かない。-C 版で ask を適用できるのは hook だけ
// なので、正規化した `git <sub> ...` に対しても deny > ask > allow の順で判定する。
describe("evaluateCommand - git -C と ask ルール", () => {
  const askRule = (p: string): Rule => ({ category: "ask", pattern: `Bash(${p})`, regex: patternToRegex(p) });
  const rules = [...loadRepoRules(), askRule("git push *"), askRule("git commit *")];
  const evaluate = (command: string) =>
    evaluateCommand(parseShellCommands(command), rules, command, {});

  test.each([
    'git -C /r commit -m "fix bug"',
    "git -C /r push origin main",
    "git --no-pager -C /r commit -m x",
    "git -C $R push origin main",
    'git -C "${R}" commit -m x',
    "R=/x; git -C $R push origin main",
    // 複合コマンドでも ask のセグメントがあれば ask (hook allow しない)
    "git -C /r status && git -C /r push origin main",
  ])("非 -C allow と ask の両方に一致する %j は ask", (command) => {
    expect(evaluate(command).decision).toBe("ask");
  });

  // matchCommand は -C の無いコマンドでは allow を ask より先に見るので、evaluateCommand の判定は
  // allow (pass-through) になる。hook allow は全セグメントを ask とも照合し、確認を省略させない
  test.each([
    "git -C /r status && git push origin main",
    "git push origin main; git -C /r status",
    "git -C /r status && git commit -m x",
    // -C の無い git でも、語が消えた形 (`git -C diff push origin main` は `git push origin main`) でも
    "R=/x; git -C $R diff push origin main",
  ])("allow と ask の両方に一致するセグメントを含む %j は hookApproved ではない", (command) => {
    expect(evaluate(command)).not.toEqual({ decision: "allow", hookApproved: true });
  });

  test("git 以外のセグメントも ask と照合する", () => {
    const makeRules: Rule[] = [
      ...rules,
      { category: "allow", pattern: "Bash(make *)", regex: patternToRegex("make *"), readByClaudeCode: true },
      askRule("make deploy *"),
    ];
    const command = "git -C /r status && make deploy prod";
    expect(evaluateCommand(parseShellCommands(command), makeRules, command, {})).toEqual({
      decision: "allow",
      hookApproved: false,
    });
    const allowed = "git -C /r status && make build";
    expect(evaluateCommand(parseShellCommands(allowed), makeRules, allowed, {})).toEqual({
      decision: "allow",
      hookApproved: true,
    });
  });

  test("ask に一致しない git -C /r status は ask にならない", () => {
    expect(evaluate("git -C /r status")).toEqual({ decision: "allow", hookApproved: true });
  });

  test("deny は ask より優先: git -C /r push --force は deny", () => {
    expect(evaluate("git -C /r push --force").decision).toBe("deny");
    expect(evaluate("git -C $R push --force").decision).toBe("deny");
  });
});

// hook の allow は Claude Code 本体の確認を省略させるので、その根拠になる allow ルールは
// 本体が通常適用するユーザ設定 (~/.claude/settings.json) に限る (例外は ADR 0003 の既知の制約:
// --setting-sources / SDK の settingSources でユーザ設定を除いた構成)。
// .codex/* や hook 入力の cwd 基準の .claude/* はリポジトリ内容 (エージェントが書ける /
// clone 元が仕込める) で、本体は読まないので allow の根拠にしない (deny / ask には使う)。
// プロジェクト (CLAUDE_PROJECT_DIR) の .claude/settings*.json の allow も、本体が適用しない
// 構成 (--setting-sources user / SDK の settingSources、未信頼のワークスペース) があるので根拠にしない。
describe("evaluateCommand - hook allow の根拠になる設定ファイル", () => {
  let fx: GitFixture;
  let home: string;
  /** managed settings の置き場所 (テストごとに中身を消す) */
  let managedDir: string;
  let managedSources: ManagedSettingsSources;
  beforeAll(() => {
    fx = createGitFixture();
    home = mkdtempSync(join(tmpdir(), "evaluator-sources-"));
    managedDir = mkdtempSync(join(tmpdir(), "evaluator-managed-"));
    managedSources = {
      file: join(managedDir, "managed-settings.json"),
      dropInDir: join(managedDir, "managed-settings.d"),
      opaque: [join(managedDir, "com.anthropic.claudecode.plist")],
    };
  });
  afterAll(() => {
    fx.cleanup();
    rmSync(home, { recursive: true, force: true });
    rmSync(managedDir, { recursive: true, force: true });
  });
  afterEach(() => {
    for (const dir of [join(home, ".claude"), join(fx.main, ".codex"), join(fx.main, ".claude"), join(fx.main, "sub", ".claude")]) {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const name of readdirSync(managedDir)) {
      const path = join(managedDir, name);
      chmodSync(path, 0o700);
      rmSync(path, { recursive: true, force: true });
    }
  });

  function writeSettings(path: string, permissions: Record<string, string[]>) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ permissions }));
  }

  function evaluate(
    command: string,
    opts: { cwd?: string; env?: Record<string, string>; managed?: ManagedSettingsSources | null } = {},
  ) {
    const cwd = opts.cwd ?? fx.main;
    const env = opts.env ?? { HOME: home, CLAUDE_PROJECT_DIR: fx.main };
    const managed = opts.managed === undefined ? managedSources : opts.managed;
    return evaluateCommand(parseShellCommands(command), loadRules(cwd, env, managed), command, {});
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
  ])("プロジェクトルート (CLAUDE_PROJECT_DIR) の .claude/%s の allow は hookApproved の根拠にしない", (_, file) => {
    writeSettings(join(fx.main, ".claude", file), submoduleAllow);
    expect(evaluate("git -C . submodule foreach touch pwned")).toEqual(passThrough);
  });

  test("cwd がサブディレクトリでもプロジェクトルートの .claude/settings.json の allow は hookApproved の根拠にしない", () => {
    writeSettings(join(fx.main, ".claude", "settings.json"), submoduleAllow);
    expect(evaluate("git -C . submodule status", { cwd: join(fx.main, "sub") })).toEqual(passThrough);
  });

  test("~/.claude/settings.json の allow は hookApproved", () => {
    writeSettings(join(home, ".claude", "settings.json"), submoduleAllow);
    expect(evaluate("git -C . submodule status")).toEqual(hookApproved);
  });

  test("プロジェクトの allow があっても、ユーザ設定の allow があれば hookApproved", () => {
    writeSettings(join(fx.main, ".claude", "settings.json"), submoduleAllow);
    writeSettings(join(home, ".claude", "settings.json"), submoduleAllow);
    expect(evaluate("git -C . submodule status")).toEqual(hookApproved);
  });

  // 本体は auto mode で Bash(*) のような広い allow を落とす。hook allow の根拠は
  // `git <リテラルのサブコマンド>` で始まる allow (サブコマンド位置に anchor されるもの) に限る
  describe("サブコマンドをリテラルで固定しない allow は hookApproved の根拠にしない", () => {
    test.each(["Bash(*)", "Bash", "Bash(git *)", "Bash(git:*)", "Bash(g*)", "Bash(git s*)", "Bash(git status*)", "Bash(git -C *)"])(
      "%s",
      (pattern) => {
        writeSettings(join(home, ".claude", "settings.json"), { allow: [pattern] });
        expect(evaluate("git -C . status")).toEqual(passThrough);
      },
    );

    test.each(["Bash(git status *)", "Bash(git status:*)", "Bash(git status)"])("%s は hookApproved", (pattern) => {
      writeSettings(join(home, ".claude", "settings.json"), { allow: [pattern] });
      expect(evaluate("git -C . status")).toEqual(hookApproved);
    });

    test("複数語のサブコマンド Bash(git stash list *) は hookApproved", () => {
      writeSettings(join(home, ".claude", "settings.json"), { allow: ["Bash(git stash list *)"] });
      expect(evaluate("git -C . stash list")).toEqual(hookApproved);
    });

    test("広い allow と狭い allow の両方があれば狭い allow を根拠に hookApproved", () => {
      writeSettings(join(home, ".claude", "settings.json"), { allow: ["Bash(*)", "Bash(git status *)"] });
      expect(evaluate("git -C . status")).toEqual(hookApproved);
      expect(evaluate("git -C . submodule foreach touch pwned")).toEqual(passThrough);
    });
  });

  // 複合コマンドの git 以外のセグメントも、ユーザ設定のコマンド名を固定した allow に
  // 肯定的に一致する必要がある (git -C 以外のセグメントの出自も git -C と同じ条件)
  describe("複合コマンドの git 以外のセグメント", () => {
    const gitStatus = "Bash(git status *)";

    test("ユーザ設定にコマンド名を固定した allow があれば hookApproved", () => {
      writeSettings(join(home, ".claude", "settings.json"), { allow: [gitStatus, "Bash(sleep *)"] });
      expect(evaluate("git -C . status; sleep 1")).toEqual(hookApproved);
    });

    test.each([
      [".codex/settings.json", () => join(fx.main, ".codex", "settings.json")],
      ["プロジェクトの .claude/settings.json", () => join(fx.main, ".claude", "settings.json")],
    ] as const)("%s にだけある allow は根拠にしない", (_, path) => {
      writeSettings(join(home, ".claude", "settings.json"), { allow: [gitStatus] });
      writeSettings(path(), { allow: ["Bash(sleep *)"] });
      expect(evaluate("git -C . status; sleep 1")).toEqual(passThrough);
    });

    test.each(["Bash(*)", "Bash(s*)", "Bash(sleep*)"])("コマンド名を固定しない %s は根拠にしない", (pattern) => {
      writeSettings(join(home, ".claude", "settings.json"), { allow: [gitStatus, pattern] });
      expect(evaluate("git -C . status; sleep 1")).toEqual(passThrough);
    });

    // ラッパー・組み込みコマンドは allow の照合 (先頭のコマンド名) と実際の実行内容がずれる、
    // またはシェルの状態を変えうるので、ユーザ設定に allow があっても根拠にしない
    test.each([
      ["Bash(command *)", "git -C . status; command touch pwned"],
      ["Bash(printf *)", "git -C . status; printf x"],
      ["Bash(nohup *)", "git -C . status; nohup touch pwned"],
    ])("%s", (pattern, command) => {
      writeSettings(join(home, ".claude", "settings.json"), { allow: [gitStatus, pattern] });
      expect(evaluate(command)).toEqual(passThrough);
    });

    test("ユーザ設定の deny は git 以外のセグメントにも効く", () => {
      writeSettings(join(home, ".claude", "settings.json"), { allow: [gitStatus, "Bash(sleep *)"], deny: ["Bash(sleep 9 *)"] });
      expect(evaluate("git -C . status; sleep 9 x").decision).toBe("deny");
    });
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

  // CLAUDE_CONFIG_DIR があると本体はユーザ設定をそこから読むが、hook はその所在
  // (deny / ask を含む) を確実には追えないので、値に関わらず hook allow しない
  test.each([
    ["~/.claude 以外の絶対パス", (h: string) => join(h, "elsewhere")],
    ["~/.claude と同じパス", (h: string) => join(h, ".claude")],
    ["空文字列", () => ""],
  ] as const)("CLAUDE_CONFIG_DIR が環境にあれば (%s) hookApproved にしない", (_, configDir) => {
    writeSettings(join(home, ".claude", "settings.json"), submoduleAllow);
    writeSettings(join(fx.main, ".claude", "settings.json"), submoduleAllow);
    expect(
      evaluate("git -C . submodule status", {
        env: { HOME: home, CLAUDE_PROJECT_DIR: fx.main, CLAUDE_CONFIG_DIR: configDir(home) },
      }),
    ).toEqual(passThrough);
  });

  // HOME が使えないと本体のユーザ設定の所在が分からない。相対パスを hook プロセスの
  // 作業ディレクトリ基準で解決して、本体が読まないファイルを根拠にすることもしない
  test.each([
    ["未設定", {}],
    ["空文字列", { HOME: "" }],
    ["相対パス", { HOME: "home" }],
  ] as const)("HOME が%sなら hookApproved にしない", (_, homeEnv) => {
    writeSettings(join(fx.main, ".claude", "settings.json"), submoduleAllow);
    expect(
      evaluate("git -C . submodule status", { env: { ...homeEnv, CLAUDE_PROJECT_DIR: fx.main } }),
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

  // 本体は .claude/settings.local.json を git リポジトリのルート (worktree では main checkout の
  // ルート) から読む (https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository)。
  // その deny / ask は本体では -C 版に効かないので hook が読んで評価する。
  describe("リポジトリルート / main checkout の .claude/settings.local.json", () => {
    const gitAllow = { allow: ["Bash(git log *)", "Bash(git push *)", "Bash(git status *)"] };
    const mainLocal = () => join(fx.main, ".claude", "settings.local.json");

    test("前提: worktree のセッションで git -C . log は hookApproved", () => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      expect(evaluate("git -C . log", { cwd: fx.worktree, env: { HOME: home, CLAUDE_PROJECT_DIR: fx.worktree } })).toEqual(
        hookApproved,
      );
    });

    test("worktree のセッションで main checkout の settings.local.json の deny が効く", () => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      writeSettings(mainLocal(), { deny: ["Bash(git log *)"] });
      expect(
        evaluate("git -C . log", { cwd: fx.worktree, env: { HOME: home, CLAUDE_PROJECT_DIR: fx.worktree } }).decision,
      ).toBe("deny");
    });

    test("worktree のセッションで main checkout の settings.local.json の ask が効く", () => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      writeSettings(mainLocal(), { ask: ["Bash(git push *)"] });
      expect(
        evaluate("git -C . push origin main", { cwd: fx.worktree, env: { HOME: home, CLAUDE_PROJECT_DIR: fx.worktree } })
          .decision,
      ).toBe("ask");
    });

    test("サブディレクトリで開始したセッションでリポジトリルートの settings.local.json の ask が効く", () => {
      const sub = join(fx.main, "sub");
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      writeSettings(mainLocal(), { ask: ["Bash(git push *)"] });
      expect(evaluate("git -C . push origin main", { cwd: sub, env: { HOME: home, CLAUDE_PROJECT_DIR: sub } }).decision).toBe(
        "ask",
      );
    });

    test("main checkout の settings.local.json の allow は hookApproved の根拠にしない", () => {
      writeSettings(mainLocal(), submoduleAllow);
      expect(
        evaluate("git -C . submodule status", { cwd: fx.worktree, env: { HOME: home, CLAUDE_PROJECT_DIR: fx.worktree } }),
      ).toEqual(passThrough);
    });

    // 本体は git 管理外ではルートを探さず開始ディレクトリの .claude/settings.local.json を読む (hook も読む)
    test("CLAUDE_PROJECT_DIR が git 管理外でも hookApproved", () => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      expect(evaluate("git -C . log", { env: { HOME: home, CLAUDE_PROJECT_DIR: fx.plain } })).toEqual(hookApproved);
    });

    // リポジトリだが hook が解決できない (本体が読む settings.local.json の位置を特定できない) 形
    test.each([
      ["core.worktree を設定したリポジトリ", (f: GitFixture) => f.coreWorktree],
      ["common dir の名前が .git でないリポジトリの worktree", (f: GitFixture) => join(f.base, "sepgit-wt")],
    ] as const)("CLAUDE_PROJECT_DIR が%sなら hookApproved にしない", (_, projectDir) => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      expect(evaluate("git -C . log", { env: { HOME: home, CLAUDE_PROJECT_DIR: projectDir(fx) } })).toEqual(passThrough);
    });
  });

  // managed settings (組織が配布する管理設定) の deny / ask は本体では -C 版に効かないので、
  // hook が読んで評価する。hook が読めない / 解釈できない管理設定があれば hook allow しない。
  describe("managed settings", () => {
    const gitAllow = { allow: ["Bash(git log *)", "Bash(git push *)", "Bash(git status *)"] };

    test("前提: managed settings が無ければ hookApproved", () => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      expect(evaluate("git -C . log")).toEqual(hookApproved);
    });

    test("managed-settings.json の deny は git -C の正規化候補に効く", () => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      writeSettings(managedSources.file, { deny: ["Bash(git log *)"] });
      expect(evaluate("git -C . log").decision).toBe("deny");
    });

    test("managed-settings.json の ask は git -C の正規化候補に効く", () => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      writeSettings(managedSources.file, { ask: ["Bash(git push *)"] });
      expect(evaluate("git -C . push origin main").decision).toBe("ask");
    });

    test("managed-settings.d/*.json の deny は git -C の正規化候補に効く", () => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      writeSettings(join(managedSources.dropInDir, "20-security.json"), { deny: ["Bash(git log *)"] });
      expect(evaluate("git -C . log").decision).toBe("deny");
    });

    test("managed-settings.d の隠しファイルと .json 以外は本体と同じく読まない", () => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      writeSettings(join(managedSources.dropInDir, ".hidden.json"), { deny: ["Bash(git log *)"] });
      writeFileSync(join(managedSources.dropInDir, "notes.txt"), "not json");
      expect(evaluate("git -C . log")).toEqual(hookApproved);
    });

    test("managed settings の allow は hookApproved の根拠にしない", () => {
      writeSettings(managedSources.file, submoduleAllow);
      expect(evaluate("git -C . submodule status")).toEqual(passThrough);
    });

    test("空の managed-settings.json は {} として扱う", () => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      writeFileSync(managedSources.file, "");
      expect(evaluate("git -C . log")).toEqual(hookApproved);
    });

    // 本体は allowManagedPermissionRulesOnly で managed 以外の allow を捨てる。不正な値は
    // 制限側に読むので、false 以外なら hook allow しない
    test.each([
      ["true", true],
      ["不正な値", "yes"],
    ] as const)("allowManagedPermissionRulesOnly が %s なら hookApproved にしない", (_, value) => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      writeFileSync(managedSources.file, JSON.stringify({ allowManagedPermissionRulesOnly: value }));
      expect(evaluate("git -C . log")).toEqual(passThrough);
    });

    // policyHelper (管理設定を生成するコマンド) と wslInheritsWindowsSettings (Windows 側の
    // 管理設定の継承) は、hook が内容を読まない管理設定を本体に適用させうる。値に関わらず hook allow しない
    test.each([
      ["managed-settings.json の policyHelper", (s: ManagedSettingsSources) => s.file, { policyHelper: { path: "/x" } }],
      ["managed-settings.json の wslInheritsWindowsSettings", (s: ManagedSettingsSources) => s.file, { wslInheritsWindowsSettings: true }],
      ["managed-settings.json の wslInheritsWindowsSettings (false)", (s: ManagedSettingsSources) => s.file, { wslInheritsWindowsSettings: false }],
      [
        "managed-settings.d/*.json の policyHelper",
        (s: ManagedSettingsSources) => join(s.dropInDir, "10-helper.json"),
        { policyHelper: { path: "/x" } },
      ],
    ] as const)("%s があれば hookApproved にしない", (_, path, settings) => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      mkdirSync(managedSources.dropInDir, { recursive: true });
      writeFileSync(path(managedSources), JSON.stringify(settings));
      expect(evaluate("git -C . log")).toEqual(passThrough);
    });

    test("allowManagedPermissionRulesOnly が false なら hookApproved", () => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      writeFileSync(managedSources.file, JSON.stringify({ allowManagedPermissionRulesOnly: false }));
      expect(evaluate("git -C . log")).toEqual(hookApproved);
    });

    // 解釈できない managed settings は deny / ask を取りこぼしうるので hook allow しない (例外にもしない)
    test.each([
      ["managed-settings.json が JSON でない", (s: ManagedSettingsSources) => writeFileSync(s.file, "{")],
      ["managed-settings.json のトップレベルが配列", (s: ManagedSettingsSources) => writeFileSync(s.file, "[]")],
      [
        "managed-settings.json の permissions.deny が配列でない",
        (s: ManagedSettingsSources) => writeFileSync(s.file, JSON.stringify({ permissions: { deny: "Bash(git log *)" } })),
      ],
      [
        "managed-settings.json の permissions.ask に文字列以外",
        (s: ManagedSettingsSources) => writeFileSync(s.file, JSON.stringify({ permissions: { ask: [1] } })),
      ],
      ["managed-settings.json がディレクトリ", (s: ManagedSettingsSources) => mkdirSync(s.file)],
      [
        "managed-settings.json が読めない",
        (s: ManagedSettingsSources) => {
          writeFileSync(s.file, "{}");
          chmodSync(s.file, 0o000);
        },
      ],
      [
        "managed-settings.d の *.json が JSON でない",
        (s: ManagedSettingsSources) => {
          mkdirSync(s.dropInDir);
          writeFileSync(join(s.dropInDir, "10-x.json"), "{");
        },
      ],
      ["managed-settings.d がディレクトリでない", (s: ManagedSettingsSources) => writeFileSync(s.dropInDir, "{}")],
      [
        "managed-settings.d が読めない",
        (s: ManagedSettingsSources) => {
          mkdirSync(s.dropInDir);
          chmodSync(s.dropInDir, 0o000);
        },
      ],
      // macOS の MDM プロファイル等、hook が内容を読まない管理ソース
      ["内容を読めない管理ソース (MDM プロファイル) が存在する", (s: ManagedSettingsSources) => writeFileSync(s.opaque[0], "")],
    ] as const)("%s なら hookApproved にしない", (_, setup) => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      setup(managedSources);
      expect(evaluate("git -C . log")).toEqual(passThrough);
    });

    test("managed settings の所在が分からない (未対応の OS) なら hookApproved にしない", () => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      expect(evaluate("git -C . log", { managed: null })).toEqual(passThrough);
    });

    // サーバー管理設定 (claude.ai の組織ポリシー) は hook から内容を確実には読めない。
    // 本体のキャッシュ (~/.claude/remote-settings.json) があればサーバー管理設定がありうるので hook allow しない
    test("サーバー管理設定のキャッシュ ~/.claude/remote-settings.json があれば hookApproved にしない", () => {
      writeSettings(join(home, ".claude", "settings.json"), gitAllow);
      writeFileSync(join(home, ".claude", "remote-settings.json"), "{}");
      expect(evaluate("git -C . log")).toEqual(passThrough);
    });
  });
});

// managed settings の所在 (https://code.claude.com/docs/en/managed-settings)
describe("defaultManagedSettingsSources", () => {
  test("macOS は /Library/Application Support/ClaudeCode と MDM の管理プロファイル", () => {
    const sources = defaultManagedSettingsSources("darwin", "alice");
    expect(sources).toEqual({
      file: "/Library/Application Support/ClaudeCode/managed-settings.json",
      dropInDir: "/Library/Application Support/ClaudeCode/managed-settings.d",
      opaque: [
        "/Library/Managed Preferences/com.anthropic.claudecode.plist",
        "/Library/Managed Preferences/alice/com.anthropic.claudecode.plist",
      ],
    });
  });

  test("Linux / WSL は /etc/claude-code", () => {
    expect(defaultManagedSettingsSources("linux", "alice")).toEqual({
      file: "/etc/claude-code/managed-settings.json",
      dropInDir: "/etc/claude-code/managed-settings.d",
      opaque: [],
    });
  });

  // Windows はレジストリ (HKLM / HKCU) を hook から読まないので所在不明として扱う
  test.each(["win32", "freebsd"] as const)("%s は null (所在不明)", (platform) => {
    expect(defaultManagedSettingsSources(platform, "alice")).toBeNull();
  });
});

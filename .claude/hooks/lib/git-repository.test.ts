import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitFixture, envWithoutGit, type GitFixture } from "./git-fixture.ts";
import { localSettingsRootsOf } from "./git-repository.ts";

// 本体が .claude/settings.local.json を読むリポジトリのルート (worktree では main checkout のルート)。
// hook は git を実行せずファイルシステムだけで解決し、git の解釈と一致する保証の無い形は
// null (特定できない。rules.ts の loadRules はそのセッションで hook allow しない) にする。
describe("localSettingsRootsOf: リポジトリの形", () => {
  let fx: GitFixture;
  beforeAll(() => { fx = createGitFixture(); });
  afterAll(() => { fx.cleanup(); });

  test.each([
    ["submodule 相当 (別 common dir)", (f: GitFixture) => join(f.main, "sm"), (f: GitFixture) => [join(f.main, "sm")]],
    ["main 内に git init した別リポジトリ", (f: GitFixture) => join(f.main, "nested"), (f: GitFixture) => [join(f.main, "nested")]],
    // 相対パスは .git ファイルのあるディレクトリ基準で解決する
    ["相対パスの .git ファイル", (f: GitFixture) => join(f.main, "rel"), (f: GitFixture) => [join(f.main, "rel"), f.main]],
    ["相対パスの .git ファイルがある階層の下", (f: GitFixture) => join(f.main, "rel", "inner"), (f: GitFixture) => [join(f.main, "rel"), f.main]],
    ["同一リポジトリ内へのシンボリックリンク", (f: GitFixture) => join(f.main, "link-sub"), (f: GitFixture) => [f.main]],
    ["別リポジトリへのシンボリックリンク", (f: GitFixture) => join(f.main, "link-other"), (f: GitFixture) => [f.other]],
    ["worktreeConfig 有効: main 自身 (sparse-checkout cone の config.worktree)", (f: GitFixture) => f.worktreeConfig, (f: GitFixture) => [f.worktreeConfig]],
    ["worktreeConfig 有効: sparse-checkout cone の worktree", (f: GitFixture) => join(f.base, "wtc-sparse"), (f: GitFixture) => [join(f.base, "wtc-sparse"), f.worktreeConfig]],
    ["相対パスでリンクした worktree (worktree.useRelativePaths)", (f: GitFixture) => join(f.base, "wtc-rel"), (f: GitFixture) => [join(f.base, "wtc-rel"), f.worktreeConfig]],
  ] as const)("%s", (_, dir, expected) => {
    expect(localSettingsRootsOf(dir(fx), {})).toEqual(expected(fx));
  });

  test.each([
    ["main 内の bare リポジトリ", (f: GitFixture) => join(f.main, "bare.git")],
    ["main の .git ディレクトリ配下", (f: GitFixture) => join(f.main, ".git", "hooks")],
    ["不正な内容の .git ファイル", (f: GitFixture) => join(f.main, "badgit")],
    // .git がシンボリックリンクの場合は解決しない (安全側)
    [".git がシンボリックリンク", (f: GitFixture) => join(f.main, "symgit")],
    ["手で作った gitdir の config.worktree に core.worktree", (f: GitFixture) => join(f.main, "crafted-wtconfig")],
    // git が作った worktree だけを認める: gitdir は common dir 自身か <common>/worktrees/<name>
    // で、<common>/worktrees/<name>/gitdir が対象の .git ファイルを指し返していること
    ["commondir は main だが gitdir が worktrees/<name> 配下でない", (f: GitFixture) => join(f.main, "notwt")],
    ["正規の worktree の gitdir を指すが逆リンクが一致しない", (f: GitFixture) => join(f.main, "hijack")],
    // 位置 (<common>/worktrees/<name>) と逆リンクの条件を満たしても、`.git` がディレクトリなら
    // commondir を持つ時点で linked worktree とは認めない
    ["<common>/worktrees/.git に置いた commondir 付きの .git ディレクトリ", (f: GitFixture) => join(f.main, ".git", "worktrees")],
    ["worktreeConfig 有効 + 手で作った gitdir の config.worktree に core.fsmonitor", (f: GitFixture) => join(f.worktreeConfig, "crafted")],
    // 防御として、正規の worktree でも config.worktree に sparse-checkout 以外の設定があれば null
    ["正規の worktree の config.worktree に core.fsmonitor", (f: GitFixture) => join(f.base, "wtc-evil")],
  ] as const)("%s は null (特定できない)", (_, dir) => {
    expect(localSettingsRootsOf(dir(fx), {})).toBeNull();
  });

  // 手で作った gitdir を拒否する理由: common dir が同じでも、extensions.worktreeConfig が
  // 有効なら git はその gitdir の config.worktree を読む (core.fsmonitor 等で任意コマンド実行)。
  test("前提: worktreeConfig 有効時、git は手で作った gitdir の config.worktree を読む", () => {
    const run = (...args: string[]) =>
      spawnSync("git", ["-C", join(fx.worktreeConfig, "crafted"), ...args], {
        encoding: "utf8",
        env: envWithoutGit({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
      });
    const common = run("rev-parse", "--path-format=absolute", "--git-common-dir");
    expect(common.status).toBe(0);
    expect(common.stdout.trim()).toBe(join(fx.worktreeConfig, ".git"));
    const fsmonitor = run("config", "--get", "core.fsmonitor");
    expect({ status: fsmonitor.status, stdout: fsmonitor.stdout.trim() }).toEqual({
      status: 0,
      stdout: "touch MARKER; false",
    });
  });

  test.each([
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_INDEX_FILE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  ])("環境変数 %s があれば null", (name) => {
    expect(localSettingsRootsOf(fx.main, { [name]: "/x" })).toBeNull();
  });
});

// 本体が .claude/settings.local.json を読むリポジトリのルート (worktree では main checkout のルート)
describe("localSettingsRootsOf", () => {
  let fx: GitFixture;
  beforeAll(() => { fx = createGitFixture(); });
  afterAll(() => { fx.cleanup(); });

  test.each([
    ["リポジトリのルート", (f: GitFixture) => f.main, (f: GitFixture) => [f.main]],
    ["サブディレクトリ", (f: GitFixture) => join(f.main, "sub", "dir"), (f: GitFixture) => [f.main]],
    ["worktree (作業ツリーのルートと main checkout のルート)", (f: GitFixture) => f.worktree, (f: GitFixture) => [f.worktree, f.main]],
    ["worktreeConfig 有効なリポジトリの worktree",(f: GitFixture) => join(f.base, "wtc-wt"), (f: GitFixture) => [join(f.base, "wtc-wt"), f.worktreeConfig]],
    ["common dir の名前が .git でない main checkout", (f: GitFixture) => join(f.base, "sepgit"), (f: GitFixture) => [join(f.base, "sepgit")]],
    ["git 管理外", (f: GitFixture) => f.plain, () => []],
  ] as const)("%s", (_, dir, expected) => {
    expect(localSettingsRootsOf(dir(fx), {})).toEqual(expected(fx));
  });

  test.each([
    ["core.worktree を設定したリポジトリ", (f: GitFixture) => f.coreWorktree],
    ["common dir の名前が .git でないリポジトリの worktree", (f: GitFixture) => join(f.base, "sepgit-wt")],
    ["手で作った gitdir", (f: GitFixture) => join(f.main, "crafted")],
    ["存在しないパス", (f: GitFixture) => join(f.main, "no-such-dir")],
    ["相対パス", (f: GitFixture) => f.main.slice(1)],
  ] as const)("%s は null (特定できない)", (_, dir) => {
    expect(localSettingsRootsOf(dir(fx), {})).toBeNull();
  });

  test("GIT_DIR が環境にあれば null", () => {
    expect(localSettingsRootsOf(fx.main, { GIT_DIR: "/x" })).toBeNull();
  });
});

// config.worktree は sparse-checkout が書く `[core] sparseCheckout*` / `[index] sparse` の
// 真偽値だけを許す allowlist。git の config パーサが別の解釈をしうる字句 (大小文字・
// サブセクション・BOM・改行の種類・継続行・同じ行の複数要素・NUL 等) の境界を固定する。
describe("localSettingsRootsOf: config.worktree の allowlist の境界", () => {
  let fx: GitFixture;
  let configWorktree: string;
  beforeAll(() => {
    fx = createGitFixture();
    configWorktree = join(fx.worktreeConfig, ".git", "worktrees", "wtc-wt", "config.worktree");
  });
  afterAll(() => { fx.cleanup(); });
  afterEach(() => { rmSync(configWorktree, { recursive: true, force: true }); });

  /** worktree wtc-wt の config.worktree を content にしたとき、ルートを特定できるか */
  const resolvable = () => localSettingsRootsOf(join(fx.base, "wtc-wt"), {}) !== null;
  const sameWith = (content: string) => {
    writeFileSync(configWorktree, content);
    return resolvable();
  };

  test.each([
    ["空ファイル", ""],
    ["[core] sparseCheckout", "[core]\n\tsparseCheckout = true\n"],
    ["[core] sparseCheckoutCone と [index] sparse", "[core]\n\tsparseCheckoutCone = false\n[index]\n\tsparse = yes\n"],
    ["セクション名の大文字 ([CORE])", "[CORE]\n\tsparseCheckout = true\n"],
    ["キー名の大小文字", "[core]\n\tSPARSECHECKOUT = On\n"],
    ["先頭の BOM", "\uFEFF[core]\n\tsparseCheckout = true\n"],
    ["CRLF", "[core]\r\n\tsparseCheckout = true\r\n"],
    ["重複したセクション", "[core]\n\tsparseCheckout = true\n[index]\n\tsparse = true\n[core]\n\tsparseCheckoutCone = true\n"],
    ["; コメント", "; c\n[index]\n\tsparse = 1\n"],
    ["# コメント", "# c\n[index]\n\tsparse = 0\n"],
  ])("%s は true", (_, content) => {
    expect(sameWith(content)).toBe(true);
  });

  test.each([
    ["[CORE] の fsmonitor", '[CORE]\n\tfsmonitor = "touch X; false"\n'],
    ["サブセクション [core \"x\"]", '[core]\n\tsparseCheckout = true\n[core "x"]\n\tfsmonitor = x\n'],
    ["BOM の後の fsmonitor", '\uFEFF[core]\n\tfsmonitor = "touch X; false"\n'],
    ["単独の CR で区切った fsmonitor", '[core]\r\tfsmonitor = "touch X; false"\n'],
    ["真偽値の後に CR と fsmonitor", '[core]\n\tsparseCheckout = true\rfsmonitor = "touch X; false"\n'],
    ["ヘッダと同じ行の fsmonitor", '[core]fsmonitor = "touch X; false"\n'],
    ["ヘッダと同じ行の sparseCheckout", "[core] sparseCheckout = true\n"],
    ["\\ による継続行", '[core]\n\tsparseCheckout = true\\\n\tfsmonitor = "touch X; false"\n'],
    ["プロトタイプのプロパティ名のセクション [constructor]", "[constructor]\n\tsparse = true\n"],
    ["プロトタイプのプロパティ名のセクション [toString]", "[toString]\n\tsparse = true\n"],
    ["NUL の後の fsmonitor", "[core]\n\tsparseCheckout = true\0fsmonitor = x\n"],
    ["U+2028 の後の fsmonitor", "[core]\n\tsparseCheckout = true\u2028fsmonitor = x\n"],
    ["キーにドット", "[core]\n\tsparseCheckout.x = true\n"],
    ["値の無いキー (暗黙の true)", "[core]\n\tsparseCheckout\n"],
    ["値の後のコメント", "[core]\n\tsparseCheckout = true # c\n"],
    ["クォートした値", '[core]\n\tsparseCheckout = "true"\n'],
    ["真偽値でない値", "[core]\n\tsparseCheckout = always\n"],
    ["セクション外のキー", "sparseCheckout = true\n"],
    ["空白を含むヘッダ [core ]", "[core ]\n\tsparseCheckout = true\n"],
    ["許可外のセクション [extensions]", "[extensions]\n\tworktreeConfig = true\n"],
    ["許可外のキー [core] bare", "[core]\n\tbare = false\n"],
    ["include", "[include]\n\tpath = /tmp/x\n"],
  ])("%s は false", (_, content) => {
    expect(sameWith(content)).toBe(false);
  });

  test("config.worktree がディレクトリなら false", () => {
    mkdirSync(configWorktree);
    expect(resolvable()).toBe(false);
  });

  test("config.worktree がシンボリックリンクなら false", () => {
    const target = join(fx.base, "sparse.cfg");
    writeFileSync(target, "[core]\n\tsparseCheckout = true\n");
    symlinkSync(target, configWorktree);
    expect(resolvable()).toBe(false);
  });
});

// common dir の config は構文解析せず、core.worktree / bare / include になりうる字句があれば
// 解決不能にする。git はヘッダと同じ行の設定 (`[core] worktree = X`) も受け付けるので、
// ヘッダの `]` の後に空白以外があれば一律に解決不能にする (安全側)。
describe("localSettingsRootsOf: common config の境界", () => {
  let fx: GitFixture;
  let config: string;
  let original: string;
  beforeAll(() => {
    fx = createGitFixture();
    config = join(fx.main, ".git", "config");
    original = readFileSync(config, "utf8");
  });
  afterAll(() => { fx.cleanup(); });
  afterEach(() => { writeFileSync(config, original); });

  /** common config を content にしたとき、サブディレクトリ sub からルートを特定できるか */
  const sameWith = (content: string) => {
    writeFileSync(config, content);
    return localSettingsRootsOf(join(fx.main, "sub"), {}) !== null;
  };

  test("前提: git はヘッダと同じ行の core.worktree を読む", () => {
    writeFileSync(config, `${original}[core] worktree = ${fx.plain}\n`);
    const r = spawnSync("git", ["-C", join(fx.main, "sub"), "config", "--get", "core.worktree"], {
      encoding: "utf8",
      env: envWithoutGit({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
    });
    expect({ status: r.status, stdout: r.stdout.trim() }).toEqual({ status: 0, stdout: fx.plain });
  });

  test.each([
    ["git init が書いた config", () => original],
    [
      "通常の複数行 config (remote / branch / extensions / bare = false)",
      () =>
        [
          "[core]",
          "\trepositoryformatversion = 0",
          "\tfilemode = true",
          "\tbare = false",
          "\tlogallrefupdates = true",
          "\tignorecase = true",
          "\tprecomposeunicode = true",
          '[remote "origin"]',
          "\turl = https://example.com/x.git",
          "\tfetch = +refs/heads/*:refs/remotes/origin/*",
          '[branch "master"]',
          "\tremote = origin",
          "\tmerge = refs/heads/master",
          '[branch "feat/x"]',
          "\tbase = refs/remotes/origin/master",
          "\tremote = origin",
          "\tmerge = refs/heads/feat/x",
          "[extensions]",
          "\tworktreeConfig = true",
          "[push]",
          "\tautoSetupRemote = true",
          "",
        ].join("\n"),
    ],
    ["ヘッダの後の空白・CRLF", () => "[core]  \r\n\tbare = false\r\n"],
  ])("%s は true", (_, content) => {
    expect(sameWith(content())).toBe(true);
  });

  test.each([
    ["ヘッダと同じ行の worktree", (p: string) => `[core] worktree = ${p}\n`],
    ["ヘッダと同じ行の worktree (空白無し)", (p: string) => `[core]worktree=${p}\n`],
    ["ヘッダと同じ行の worktree (タブ)", (p: string) => `[core]\tworktree = ${p}\n`],
    ["ヘッダと同じ行の worktree (大文字のセクション)", (p: string) => `[CORE] WorkTree = ${p}\n`],
    ["インデントしたヘッダと同じ行の worktree", (p: string) => `\t[core] worktree = ${p}\n`],
    ["ヘッダと同じ行の bare", () => "[core] bare = true\n"],
    ["ヘッダと同じ行の include", () => "[include] path = /tmp/x\n"],
    ["ヘッダと同じ行の includeIf", () => '[includeIf "gitdir:/"] path = /tmp/x\n'],
    ["サブセクションのヘッダと同じ行の設定", (p: string) => `[core "x"] worktree = ${p}\n`],
    ["サブセクション名に ] を含むヘッダ", (p: string) => `[remote "a]"] worktree = ${p}\n`],
    ["# コメント付きのヘッダ", () => "[core] # c\n"],
    ["; コメント付きのヘッダ", () => "[core] ; c\n"],
    // 従来どおり行頭の形も解決不能
    ["行頭の worktree", (p: string) => `[core]\n\tworktree = ${p}\n`],
    ["行頭の bare = true", () => "[core]\n\tbare = true\n"],
    ["include セクション", () => "[include]\n\tpath = /tmp/x\n"],
  ])("%s は false", (_, content) => {
    expect(sameWith(original + content(fx.plain))).toBe(false);
  });
});

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitFixture, envWithoutGit, type GitFixture } from "./git-fixture.ts";
import { isSameGitRepository, localSettingsRootsOf } from "./git-repository.ts";

// `git -C <dir>` は <dir> のリポジトリの .git/config (core.fsmonitor 等) や .git/hooks を
// 読み込んで実行する。hook が allow してよいのは、<dir> が hook 入力の cwd と同じ
// git common dir を持つ (同一リポジトリの worktree / サブディレクトリ) 場合だけ。
describe("isSameGitRepository", () => {
  let fx: GitFixture;
  beforeAll(() => { fx = createGitFixture(); });
  afterAll(() => { fx.cleanup(); });

  const same = (cwd: string | undefined, dir: string, env: Record<string, string> = {}) =>
    isSameGitRepository(cwd, dir, env);

  describe("同一 common dir は true", () => {
    test.each([
      ["cwd 自身 (.)", (f: GitFixture) => [f.main, "."]],
      ["絶対パスの cwd 自身", (f: GitFixture) => [f.main, f.main]],
      ["サブディレクトリ", (f: GitFixture) => [f.main, "sub/dir"]],
      ["空白を含むサブディレクトリ", (f: GitFixture) => [f.main, "r x"]],
      ["cwd がサブディレクトリで対象がルート", (f: GitFixture) => [join(f.main, "sub", "dir"), "../.."]],
      ["main から worktree (相対)", (f: GitFixture) => [f.main, "../wt"]],
      ["main から worktree (絶対)", (f: GitFixture) => [f.main, f.worktree]],
      ["worktree から main", (f: GitFixture) => [f.worktree, f.main]],
      ["同一リポジトリ内へのシンボリックリンク", (f: GitFixture) => [f.main, "link-sub"]],
      ["相対パスの .git ファイル", (f: GitFixture) => [f.main, "rel"]],
      // 相対パスは対象ディレクトリではなく .git ファイルのあるディレクトリ基準で解決する
      ["相対パスの .git ファイルがある階層の下", (f: GitFixture) => [f.main, "rel/inner"]],
      // extensions.worktreeConfig=true のリポジトリでも、git worktree add で作った worktree は同一
      ["worktreeConfig 有効: main 自身 (sparse-checkout cone の config.worktree)", (f: GitFixture) => [f.worktreeConfig, "."]],
      ["worktreeConfig 有効: main から worktree", (f: GitFixture) => [f.worktreeConfig, "../wtc-wt"]],
      ["worktreeConfig 有効: worktree から main", (f: GitFixture) => [join(f.base, "wtc-wt"), f.worktreeConfig]],
      ["worktreeConfig 有効: sparse-checkout cone の worktree", (f: GitFixture) => [f.worktreeConfig, "../wtc-sparse"]],
      ["相対パスでリンクした worktree (worktree.useRelativePaths)", (f: GitFixture) => [f.worktreeConfig, "../wtc-rel"]],
    ] as const)("%s", (_, args) => {
      const [cwd, dir] = args(fx);
      expect(same(cwd, dir)).toBe(true);
    });
  });

  describe("別リポジトリ・解決できないものは false", () => {
    test.each([
      ["無関係なリポジトリ", (f: GitFixture) => [f.main, f.other]],
      ["submodule 相当 (別 common dir)", (f: GitFixture) => [f.main, "sm"]],
      ["main 内に git init した別リポジトリ", (f: GitFixture) => [f.main, "nested"]],
      ["main 内の bare リポジトリ", (f: GitFixture) => [f.main, "bare.git"]],
      ["main の .git ディレクトリ配下", (f: GitFixture) => [f.main, ".git/hooks"]],
      ["不正な内容の .git ファイル", (f: GitFixture) => [f.main, "badgit"]],
      ["存在しないパス", (f: GitFixture) => [f.main, "no-such-dir"]],
      ["ディレクトリでないパス", (f: GitFixture) => [f.main, "sub/file.txt"]],
      ["cwd がディレクトリでない", (f: GitFixture) => [join(f.main, "sub", "file.txt"), f.main]],
      // .git がシンボリックリンクの場合は解決しない (安全側)
      [".git がシンボリックリンク", (f: GitFixture) => [join(f.main, "symgit"), "."]],
      ["別リポジトリへのシンボリックリンク", (f: GitFixture) => [f.main, "link-other"]],
      // chdir(2) は `link/..` をリンク先の親として物理的に解決する (字句的な正規化では main)
      ["シンボリックリンク + .. (物理的には other)", (f: GitFixture) => [f.main, "link-inner/.."]],
      ["git 管理外のディレクトリ", (f: GitFixture) => [f.main, f.plain]],
      ["cwd が git 管理外", (f: GitFixture) => [f.plain, f.main]],
      ["cwd も対象も git 管理外", (f: GitFixture) => [f.plain, "."]],
      ["core.worktree を設定したリポジトリ", (f: GitFixture) => [f.coreWorktree, "."]],
      ["手で作った gitdir の config.worktree に core.worktree", (f: GitFixture) => [f.main, "crafted-wtconfig"]],
      // git が作った worktree だけを認める: gitdir は common dir 自身か <common>/worktrees/<name>
      // で、<common>/worktrees/<name>/gitdir が対象の .git ファイルを指し返していること
      ["手で作った gitdir (.git ディレクトリに commondir → main)", (f: GitFixture) => [f.main, "crafted"]],
      ["commondir は main だが gitdir が worktrees/<name> 配下でない", (f: GitFixture) => [f.main, "notwt"]],
      ["正規の worktree の gitdir を指すが逆リンクが一致しない", (f: GitFixture) => [f.main, "hijack"]],
      // 位置 (<common>/worktrees/<name>) と逆リンクの条件を満たしても、`.git` がディレクトリなら
      // commondir を持つ時点で linked worktree とは認めない
      ["<common>/worktrees/.git に置いた commondir 付きの .git ディレクトリ", (f: GitFixture) => [f.main, ".git/worktrees"]],
      ["worktreeConfig 有効 + 手で作った gitdir の config.worktree に core.fsmonitor", (f: GitFixture) => [f.worktreeConfig, "crafted"]],
      // 防御として、正規の worktree でも config.worktree に sparse-checkout 以外の設定があれば false
      ["正規の worktree の config.worktree に core.fsmonitor", (f: GitFixture) => [f.worktreeConfig, "../wtc-evil"]],
    ] as const)("%s", (_, args) => {
      const [cwd, dir] = args(fx);
      expect(same(cwd, dir)).toBe(false);
    });
  });

  test("cwd が無い場合は false", () => {
    expect(same(undefined, fx.main)).toBe(false);
  });

  test("cwd が相対パスの場合は false", () => {
    // 先頭の / を外した形 (hook プロセスの作業ディレクトリが / なら実在するパスになる)
    expect(same(fx.main.slice(1), ".")).toBe(false);
  });

  test("空の dir は false", () => {
    expect(same(fx.main, "")).toBe(false);
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
  ])("環境変数 %s があれば false", (name) => {
    expect(same(fx.main, ".", { [name]: "/x" })).toBe(false);
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
describe("isSameGitRepository: config.worktree の allowlist の境界", () => {
  let fx: GitFixture;
  let configWorktree: string;
  beforeAll(() => {
    fx = createGitFixture();
    configWorktree = join(fx.worktreeConfig, ".git", "worktrees", "wtc-wt", "config.worktree");
  });
  afterAll(() => { fx.cleanup(); });
  afterEach(() => { rmSync(configWorktree, { recursive: true, force: true }); });

  const sameWith = (content: string) => {
    writeFileSync(configWorktree, content);
    return isSameGitRepository(fx.worktreeConfig, "../wtc-wt", {});
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
    expect(isSameGitRepository(fx.worktreeConfig, "../wtc-wt", {})).toBe(false);
  });

  test("config.worktree がシンボリックリンクなら false", () => {
    const target = join(fx.base, "sparse.cfg");
    writeFileSync(target, "[core]\n\tsparseCheckout = true\n");
    symlinkSync(target, configWorktree);
    expect(isSameGitRepository(fx.worktreeConfig, "../wtc-wt", {})).toBe(false);
  });
});

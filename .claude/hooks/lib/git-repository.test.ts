import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createGitFixture, envWithoutGit, type GitFixture } from "./git-fixture.ts";
import { isSameGitRepository } from "./git-repository.ts";

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
      // 手で作った gitdir でも commondir が main を指せば同一リポジトリ扱い。安全性は
      // 「git は config / hooks を common dir から読む」ことに依存する (下の前提テスト)
      ["手で作った gitdir (commondir → main)", (f: GitFixture) => [f.main, "crafted"]],
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

  // 「手で作った gitdir (commondir → main)」を true にしてよい前提: git はその gitdir の
  // config ではなく common dir (main/.git) の config を読む。git の挙動が変わったら検知する。
  test("前提: git は手で作った gitdir の config を読まず、common dir の config を読む", () => {
    const run = (...args: string[]) =>
      spawnSync("git", ["-C", join(fx.main, "crafted"), ...args], {
        encoding: "utf8",
        env: envWithoutGit({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
      });
    const common = run("rev-parse", "--path-format=absolute", "--git-common-dir");
    expect(common.status).toBe(0);
    expect(common.stdout.trim()).toBe(join(fx.main, ".git"));
    const fsmonitor = run("config", "--get", "core.fsmonitor");
    expect(fsmonitor.stdout).toBe("");
    expect(fsmonitor.status).toBe(1);
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

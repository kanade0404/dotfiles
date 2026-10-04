/**
 * テスト用の git リポジトリ群を一時ディレクトリに作る。セットアップでは git を実行するが、
 * hook 本体 (git-repository.ts) は git を実行しない。
 *
 * 個人の git 設定 (署名・hook・template) と、git hook 実行中に継承される GIT_DIR /
 * GIT_INDEX_FILE 等の影響を受けないよう、GIT_* を除いた環境で実行する。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** GIT_* を取り除いた環境 (hook プロセスの起動にも使う) */
export function envWithoutGit(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  }
  return { ...env, ...overrides };
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: envWithoutGit({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

export type GitFixture = {
  /** 全体の一時ディレクトリ (realpath 済み) */
  readonly base: string;
  /** 通常のリポジトリ。sub/dir・"r x" のサブディレクトリを持つ */
  readonly main: string;
  /** main から `git worktree add` した worktree (base/wt) */
  readonly worktree: string;
  /** main と無関係なリポジトリ */
  readonly other: string;
  /** git 管理外のディレクトリ */
  readonly plain: string;
  /** core.worktree を設定したリポジトリ */
  readonly coreWorktree: string;
  /** extensions.worktreeConfig=true のリポジトリ (base/wtc)。worktree は base/wtc-* */
  readonly worktreeConfig: string;
  readonly cleanup: () => void;
};

/**
 * 構成 (base 配下):
 * - main/                 git init + 空 commit
 *   - sub/dir/, "r x"/    サブディレクトリ
 *   - sm/                 submodule 相当 (.git ファイル → main/.git/modules/sm)
 *   - nested/             main の中に git init した別リポジトリ
 *   - bare.git/           main の中の bare リポジトリ
 *   - badgit/             中身が不正な .git ファイル
 *   - rel/                相対パスの .git ファイル (gitdir: ../.git)。rel/inner/ を持つ
 *   - sub/file.txt        通常ファイル
 *   - symgit/             .git が main/.git へのシンボリックリンク
 *   - link-sub            → main/sub (同一リポジトリへのシンボリックリンク)
 *   - link-other          → other (別リポジトリへのシンボリックリンク)
 *   - link-inner          → other/inner (`link-inner/..` は物理的に other)
 *   - crafted/            git を使わず手で作った gitdir (.git/{HEAD,commondir → main/.git})。
 *                         .git/config に core.fsmonitor を書いてある
 *   - crafted-wtconfig/   crafted/ と同じ構成で、.git/config.worktree に core.worktree がある
 *   - notwt/              .git ファイル → main/fakegit/n (HEAD, commondir → main/.git, gitdir → notwt/.git)。
 *                         common dir と逆リンクは正しいが gitdir が main/.git/worktrees/<name> ではない
 *   - hijack/             .git ファイル → main/.git/worktrees/wt (wt の正規の gitdir)。
 *                         gitdir 側の逆リンク (worktrees/wt/gitdir) は wt/.git を指す
 *   - .git/worktrees/.git/ `.git` ディレクトリに HEAD・commondir (→ main/.git)・自分自身を指す
 *                         逆リンク (gitdir)。`git -C .git/worktrees` の探索で最初に見つかる
 * - wt/                   main の worktree
 * - other/inner/          無関係なリポジトリ
 * - plain/                git 管理外
 * - core-worktree/        core.worktree を設定したリポジトリ
 * - wtc/                  extensions.worktreeConfig=true のリポジトリ。main 自身に sparse-checkout (cone)
 *   - crafted/            手で作った gitdir (.git/{HEAD,commondir → wtc/.git}) の config.worktree に
 *                         core.fsmonitor (worktreeConfig 有効時、git はこれを読む)
 * - wtc-wt/               wtc の worktree
 * - wtc-sparse/           wtc の worktree + sparse-checkout (cone)
 * - wtc-rel/              wtc の worktree (worktree.useRelativePaths で相対パスのリンク)
 * - wtc-evil/             wtc の worktree。gitdir (wtc/.git/worktrees/wtc-evil) の config.worktree に core.fsmonitor
 */
export function createGitFixture(): GitFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "git-fixture-")));
  const main = join(base, "main");
  const worktree = join(base, "wt");
  const other = join(base, "other");
  const plain = join(base, "plain");
  const coreWorktree = join(base, "core-worktree");

  mkdirSync(main);
  git(main, "init", "-q");
  git(main, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(join(main, "sub", "dir"), { recursive: true });
  mkdirSync(join(main, "r x"));
  git(main, "worktree", "add", "-q", "--detach", worktree);
  mkdirSync(join(main, ".git", "modules"));
  git(main, "init", "-q", "--separate-git-dir", join(main, ".git", "modules", "sm"), join(main, "sm"));
  git(main, "init", "-q", join(main, "nested"));
  git(main, "init", "-q", "--bare", join(main, "bare.git"));
  mkdirSync(join(main, "badgit"));
  writeFileSync(join(main, "badgit", ".git"), "not a gitfile\n");
  mkdirSync(join(main, "rel", "inner"), { recursive: true });
  writeFileSync(join(main, "rel", ".git"), "gitdir: ../.git\n");
  writeFileSync(join(main, "sub", "file.txt"), "");
  mkdirSync(join(main, "symgit"));
  symlinkSync(join(main, ".git"), join(main, "symgit", ".git"));
  // エージェントが git を使わずに作れる「main と同じ common dir を指す gitdir」
  for (const name of ["crafted", "crafted-wtconfig"]) {
    const gitdir = join(main, name, ".git");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(gitdir, "commondir"), "../../.git\n");
    writeFileSync(join(gitdir, "config"), "[core]\n\tfsmonitor = false-crafted-fsmonitor\n");
  }
  writeFileSync(join(main, "crafted-wtconfig", ".git", "config.worktree"), `[core]\n\tworktree = ${plain}\n`);
  mkdirSync(join(main, "fakegit", "n"), { recursive: true });
  writeFileSync(join(main, "fakegit", "n", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(main, "fakegit", "n", "commondir"), "../../.git\n");
  writeFileSync(join(main, "fakegit", "n", "gitdir"), `${join(main, "notwt", ".git")}\n`);
  mkdirSync(join(main, "notwt"));
  writeFileSync(join(main, "notwt", ".git"), "gitdir: ../fakegit/n\n");
  mkdirSync(join(main, "hijack"));
  writeFileSync(join(main, "hijack", ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
  // `.git` ディレクトリ自体を <common>/worktrees/<name> の位置 (<common>/worktrees/.git) に置き、
  // commondir と逆リンク (自分自身を指す) を持たせる。linked worktree の条件のうち
  // 「`.git` がファイルである」以外を満たす形
  const dotGitInWorktrees = join(main, ".git", "worktrees", ".git");
  mkdirSync(dotGitInWorktrees);
  writeFileSync(join(dotGitInWorktrees, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dotGitInWorktrees, "commondir"), "../..\n");
  writeFileSync(join(dotGitInWorktrees, "gitdir"), `${dotGitInWorktrees}\n`);

  const wtc = join(base, "wtc");
  mkdirSync(wtc);
  git(wtc, "init", "-q");
  git(wtc, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  git(wtc, "config", "extensions.worktreeConfig", "true");
  for (const name of ["wtc-wt", "wtc-sparse", "wtc-evil"]) git(wtc, "worktree", "add", "-q", "--detach", join(base, name));
  git(wtc, "-c", "worktree.useRelativePaths=true", "worktree", "add", "-q", "--detach", join(base, "wtc-rel"));
  git(join(base, "wtc-sparse"), "sparse-checkout", "set", "--cone", "a");
  git(wtc, "sparse-checkout", "set", "--cone", "a");
  writeFileSync(
    join(wtc, ".git", "worktrees", "wtc-evil", "config.worktree"),
    "[core]\n\tfsmonitor = \"touch MARKER; false\"\n",
  );
  const wtcCrafted = join(wtc, "crafted", ".git");
  mkdirSync(wtcCrafted, { recursive: true });
  writeFileSync(join(wtcCrafted, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(wtcCrafted, "commondir"), "../../.git\n");
  writeFileSync(join(wtcCrafted, "config.worktree"), "[core]\n\tfsmonitor = \"touch MARKER; false\"\n");

  mkdirSync(join(other, "inner"), { recursive: true });
  git(other, "init", "-q");
  mkdirSync(plain);
  mkdirSync(coreWorktree);
  git(coreWorktree, "init", "-q");
  git(coreWorktree, "config", "core.worktree", plain);

  symlinkSync(join(main, "sub"), join(main, "link-sub"));
  symlinkSync(other, join(main, "link-other"));
  symlinkSync(join(other, "inner"), join(main, "link-inner"));

  return {
    base,
    main,
    worktree,
    other,
    plain,
    coreWorktree,
    worktreeConfig: wtc,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

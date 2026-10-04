import { lstatSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * git のリポジトリ探索や参照先を変える環境変数。hook プロセスの環境にあれば、
 * ファイルシステムからの解決結果が git の実際の挙動と一致する保証が無いので判定しない。
 */
const REPOSITORY_ENV_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_INDEX_FILE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
] as const;

class UnresolvableRepository extends Error {}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * `base` (物理パス) から `path` を chdir(2) と同じく物理的に解決する。
 * fs.realpathSync は `..` を字句的に先に畳むため (`link/..` がリンク先の親にならない)、
 * 1 要素ずつシンボリックリンクを解決しながら辿る。存在しない要素があれば例外。
 */
function physicalResolve(base: string, path: string): string {
  let current = isAbsolute(path) ? "/" : base;
  for (const component of path.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    current = realpathSync(join(current, component));
  }
  return current;
}

/** `.git` ファイル (`gitdir: <path>` の 1 行) から gitdir のパスを取り出す */
function parseGitFile(content: string): string {
  const m = /^gitdir: ([^\r\n]+)[\r\n]*$/.exec(content);
  if (!m) throw new UnresolvableRepository("不正な .git ファイル");
  return m[1];
}

/**
 * 設定ファイルに作業ツリーの付け替え (core.worktree)・bare 指定・include が無いか。
 * 構文解析はせず、該当しうる行があれば解決不能として扱う (安全側)。
 */
function assertPlainConfig(path: string): void {
  const config = readFileSync(path, "utf8");
  const bareNotFalse = /^\s*bare\b(?!\s*=\s*(?:false|no|off|0)\s*$)/im;
  if (/^\s*worktree\s*(?:=|$)/im.test(config) || bareNotFalse.test(config) || /^\s*\[\s*include/im.test(config)) {
    throw new UnresolvableRepository(`${path} に core.worktree / bare / include がある`);
  }
}

/** gitdir から common dir を求める (`commondir` ファイルがあればその参照先、無ければ gitdir 自身) */
function commonDirOf(gitdir: string): string {
  if (!statSync(join(gitdir, "HEAD")).isFile()) throw new UnresolvableRepository("gitdir に HEAD が無い");
  const commondirFile = join(gitdir, "commondir");
  const st = lstatOrNull(commondirFile);
  let common = gitdir;
  if (st !== null) {
    if (!st.isFile()) throw new UnresolvableRepository("commondir がファイルではない");
    const value = readFileSync(commondirFile, "utf8").replace(/[\r\n]+$/, "");
    if (value === "" || /[\r\n]/.test(value)) throw new UnresolvableRepository("不正な commondir");
    common = physicalResolve(gitdir, value);
  }
  assertPlainConfig(join(common, "config"));
  if (lstatOrNull(join(gitdir, "config.worktree")) !== null) assertPlainConfig(join(gitdir, "config.worktree"));
  return common;
}

/**
 * 物理パスのディレクトリ `dir` が属するリポジトリの common dir を、git を実行せずに求める。
 *
 * 祖先方向に `.git` を探す。`.git` がディレクトリならそれが gitdir、ファイルなら
 * `gitdir: <path>` (相対パスは .git ファイルのあるディレクトリ基準) の参照先が gitdir。
 * `.git` が無い階層に `HEAD` があれば、git はそこを bare リポジトリ / gitdir として扱いうる
 * (`.git` 配下や bare リポジトリの中) ので解決不能とする。
 */
function resolveCommonDir(dir: string): string {
  let current = dir;
  for (;;) {
    const dotGit = join(current, ".git");
    const st = lstatOrNull(dotGit);
    if (st !== null) {
      if (st.isDirectory()) return commonDirOf(dotGit);
      if (st.isFile()) return commonDirOf(physicalResolve(current, parseGitFile(readFileSync(dotGit, "utf8"))));
      throw new UnresolvableRepository(".git がディレクトリでも通常ファイルでもない");
    }
    if (lstatOrNull(join(current, "HEAD")) !== null) {
      throw new UnresolvableRepository("bare リポジトリ / gitdir の中");
    }
    const parent = dirname(current);
    if (parent === current) throw new UnresolvableRepository("リポジトリの外");
    current = parent;
  }
}

/**
 * `git -C <dir>` の対象が、hook 入力の cwd のリポジトリと同じ git common dir を持つか
 * (= 同一リポジトリのサブディレクトリか、同一リポジトリの worktree か)。
 *
 * `git -C <dir>` は <dir> のリポジトリの設定 (core.fsmonitor / diff.external /
 * core.sshCommand 等) と .git/hooks を使う。エージェントが書き込める任意のリポジトリを
 * 対象にすると、allow 済みの `status` 等でも確認無しに任意コマンドを実行できるので、
 * hook の allow は cwd と同じリポジトリに限る。
 *
 * git は実行せず、ファイルシステムだけで解決する。cwd が無い / 相対パス、環境変数による
 * 付け替え、存在しない・ディレクトリでないパス、`.git` ファイルの不正な内容、bare
 * リポジトリ、core.worktree、読み取りエラー等はすべて false (allow しない) にする。
 */
export function isSameGitRepository(cwd: string | undefined, dir: string, env: Env = process.env): boolean {
  try {
    if (cwd === undefined || !isAbsolute(cwd) || dir === "") return false;
    if (REPOSITORY_ENV_VARS.some((name) => env[name] !== undefined)) return false;
    const cwdPath = physicalResolve("/", cwd);
    const target = physicalResolve(cwdPath, dir);
    if (!statSync(cwdPath).isDirectory() || !statSync(target).isDirectory()) return false;
    return resolveCommonDir(cwdPath) === resolveCommonDir(target);
  } catch {
    return false;
  }
}

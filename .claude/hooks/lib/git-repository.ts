import { lstatSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

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
/** 祖先のどこにも `.git` / `HEAD` が無い (git 管理外) */
class OutsideRepository extends UnresolvableRepository {}

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

/**
 * config.worktree に置いてよい設定 (セクション → キー、小文字)。`git sparse-checkout`
 * (init / set、cone / non-cone、--sparse-index) が書くものだけ。
 */
const ALLOWED_WORKTREE_CONFIG: Readonly<Record<string, ReadonlySet<string>>> = {
  core: new Set(["sparsecheckout", "sparsecheckoutcone"]),
  index: new Set(["sparse"]),
};

/**
 * gitdir の config.worktree が無いか、sparse-checkout の真偽値設定だけか。
 *
 * extensions.worktreeConfig が有効だと git は gitdir の config.worktree も読むので、
 * core.fsmonitor / core.hooksPath / core.sshCommand / core.pager / alias.* / diff.external /
 * include 等、実行やファイル参照につながるキーを書かれうる。キーの denylist は網羅できないので、
 * sparse-checkout が書く `[core] sparseCheckout*` / `[index] sparse` の真偽値だけを許す
 * allowlist にし、それ以外 (サブセクション、同じ行の複数要素、継続行、コメント付きの値等) は
 * 解決不能として扱う。common config の extensions.worktreeConfig の有無は判定に使わない
 * (キー名の大小文字・真偽値の表記揺れを解析する必要があり、無効なら git は読まないので
 * 余分に拒否するだけで安全側)。
 */
function assertSparseOnlyWorktreeConfig(path: string): void {
  const st = lstatOrNull(path);
  if (st === null) return;
  if (!st.isFile()) throw new UnresolvableRepository("config.worktree が通常ファイルではない");
  let section: string | null = null;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([A-Za-z0-9-]+)\]$/.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(?:true|false|yes|no|on|off|1|0)$/i.exec(line);
    // `[constructor]` 等がプロトタイプのプロパティを引かないよう自身のキーだけを見る
    const allowed =
      section !== null && Object.hasOwn(ALLOWED_WORKTREE_CONFIG, section) ? ALLOWED_WORKTREE_CONFIG[section] : undefined;
    if (entry === null || allowed === undefined || !allowed.has(entry[1].toLowerCase())) {
      throw new UnresolvableRepository(`${path} に sparse-checkout 以外の設定がある`);
    }
  }
}

/**
 * gitdir が `git worktree add` で作られた linked worktree のものか。
 * - gitdir が `<common>/worktrees/<name>` の直下である
 * - `<common>/worktrees/<name>/gitdir` (git が書く逆リンク) が対象の `.git` ファイルを指す
 *   (相対パスは worktree.useRelativePaths の形式で、`<common>/worktrees/<name>` 基準)
 * 手で作った gitdir は common dir が同じでも、worktreeConfig 有効時に gitdir 側の
 * config.worktree を git に読ませられる。
 */
function assertLinkedWorktree(common: string, gitdir: string, dotGitFile: string | null): void {
  if (dotGitFile === null) throw new UnresolvableRepository(".git ディレクトリに commondir がある");
  if (dirname(gitdir) !== join(common, "worktrees")) {
    throw new UnresolvableRepository("gitdir が <common>/worktrees/<name> ではない");
  }
  const backlinkFile = join(gitdir, "gitdir");
  if (!lstatSync(backlinkFile).isFile()) throw new UnresolvableRepository("gitdir の逆リンクがファイルではない");
  const value = readFileSync(backlinkFile, "utf8").replace(/[\r\n]+$/, "");
  if (value === "" || /[\r\n]/.test(value)) throw new UnresolvableRepository("不正な gitdir の逆リンク");
  if (physicalResolve(gitdir, value) !== dotGitFile) {
    throw new UnresolvableRepository("gitdir の逆リンクが対象の .git ファイルを指さない");
  }
}

/**
 * gitdir から common dir を求める (`commondir` ファイルがあればその参照先、無ければ gitdir 自身)。
 *
 * 認めるのは git が作ったリポジトリの形だけ: gitdir が common dir 自身 (通常のリポジトリ /
 * `.git` ファイルで指した common dir) か、`git worktree add` で作った linked worktree の gitdir
 * (assertLinkedWorktree)。dotGitFile は探索で見つけた `.git` ファイルの物理パス
 * (`.git` がディレクトリなら null)。
 */
function commonDirOf(gitdir: string, dotGitFile: string | null): string {
  if (!statSync(join(gitdir, "HEAD")).isFile()) throw new UnresolvableRepository("gitdir に HEAD が無い");
  const commondirFile = join(gitdir, "commondir");
  const st = lstatOrNull(commondirFile);
  let common = gitdir;
  if (st !== null) {
    if (!st.isFile()) throw new UnresolvableRepository("commondir がファイルではない");
    const value = readFileSync(commondirFile, "utf8").replace(/[\r\n]+$/, "");
    if (value === "" || /[\r\n]/.test(value)) throw new UnresolvableRepository("不正な commondir");
    common = physicalResolve(gitdir, value);
    assertLinkedWorktree(common, gitdir, dotGitFile);
  }
  assertPlainConfig(join(common, "config"));
  assertSparseOnlyWorktreeConfig(join(gitdir, "config.worktree"));
  return common;
}

/** ファイルシステムから解決したリポジトリ (いずれも物理パス) */
type Repository = {
  /** `.git` が見つかった作業ツリーのルート */
  readonly worktreeRoot: string;
  readonly gitdir: string;
  readonly common: string;
};

/**
 * 物理パスのディレクトリ `dir` が属するリポジトリ (作業ツリーのルート・gitdir・common dir) を、
 * git を実行せずに求める。
 *
 * 祖先方向に `.git` を探す。`.git` がディレクトリならそれが gitdir、ファイルなら
 * `gitdir: <path>` (相対パスは .git ファイルのあるディレクトリ基準) の参照先が gitdir。
 * `.git` が無い階層に `HEAD` があれば、git はそこを bare リポジトリ / gitdir として扱いうる
 * (`.git` 配下や bare リポジトリの中) ので解決不能とする。
 * git 自身は `HEAD` に加えて `objects/` と `refs/` が揃った階層だけを gitdir とみなすが、
 * ここでは区別しない (安全側)。そのため作業ツリー内に `HEAD` という名前のファイル /
 * ディレクトリを持つ階層 (git を模したテストフィクスチャなど) とその配下も解決不能になり、
 * そこへの `git -C` は hook allow されない。
 */
function resolveRepository(dir: string): Repository {
  let current = dir;
  for (;;) {
    const dotGit = join(current, ".git");
    const st = lstatOrNull(dotGit);
    if (st !== null) {
      if (st.isDirectory()) return { worktreeRoot: current, gitdir: dotGit, common: commonDirOf(dotGit, null) };
      if (st.isFile()) {
        const gitdir = physicalResolve(current, parseGitFile(readFileSync(dotGit, "utf8")));
        return { worktreeRoot: current, gitdir, common: commonDirOf(gitdir, dotGit) };
      }
      throw new UnresolvableRepository(".git がディレクトリでも通常ファイルでもない");
    }
    if (lstatOrNull(join(current, "HEAD")) !== null) {
      throw new UnresolvableRepository("bare リポジトリ / gitdir の中");
    }
    const parent = dirname(current);
    if (parent === current) throw new OutsideRepository("リポジトリの外");
    current = parent;
  }
}

/**
 * Claude Code 本体が `dir` で開始したセッションの `.claude/settings.local.json` を読みうる
 * ディレクトリ (git リポジトリのルートと、worktree なら main checkout のルート) を返す。
 * ref: https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository
 *
 * - git 管理外: 空配列 (本体は開始ディレクトリの settings.local.json を読む)
 * - 作業ツリーのルート (`.git` のある階層) と、common dir の名前が `.git` ならその親
 *   (main checkout のルート) を返す
 * - linked worktree で common dir の名前が `.git` でない、または isSameGitRepository と同じ条件で
 *   解決できない (環境変数による付け替え・core.worktree・手で作った gitdir 等): null
 *   (本体が読むファイルを特定できない)
 */
export function localSettingsRootsOf(dir: string, env: Env = process.env): readonly string[] | null {
  try {
    if (!isAbsolute(dir)) return null;
    if (REPOSITORY_ENV_VARS.some((name) => env[name] !== undefined)) return null;
    const { worktreeRoot, gitdir, common } = resolveRepository(physicalResolve("/", dir));
    if (basename(common) === ".git") return [...new Set([worktreeRoot, dirname(common)])];
    return gitdir === common ? [worktreeRoot] : null;
  } catch (e) {
    return e instanceof OutsideRepository ? [] : null;
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
 * リポジトリ、core.worktree、`git worktree add` で作られていない gitdir (commondir を持つが
 * `<common>/worktrees/<name>` でない・逆リンクが一致しない)、sparse-checkout 以外の設定を
 * 含む config.worktree、読み取りエラー等はすべて false (allow しない) にする。
 */
export function isSameGitRepository(cwd: string | undefined, dir: string, env: Env = process.env): boolean {
  try {
    if (cwd === undefined || !isAbsolute(cwd) || dir === "") return false;
    if (REPOSITORY_ENV_VARS.some((name) => env[name] !== undefined)) return false;
    const cwdPath = physicalResolve("/", cwd);
    const target = physicalResolve(cwdPath, dir);
    if (!statSync(cwdPath).isDirectory() || !statSync(target).isDirectory()) return false;
    return resolveRepository(cwdPath).common === resolveRepository(target).common;
  } catch {
    return false;
  }
}

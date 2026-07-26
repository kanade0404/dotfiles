import { existsSync, readFileSync } from "node:fs";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { rewriteCodexSkillDir } from "./rewrite-codex-skill-dir.ts";

const curatedPrefix = ".rulesync/skills/.curated/";

// generatedRoots[0] は curatedPrefix と同一ディレクトリ (末尾スラッシュ無し)。
// 二重定義でズレないよう curatedPrefix から導出する。
const generatedRoots = [curatedPrefix.replace(/\/$/, "")];

// rulesync.jsonc (cwd 相対) を jsonc-parser で読み、loadExpectedSkills / isCodexTarget の
// 両方で共用する。codex は repo 直下、claude は rulesync-claude/ を cwd に走り、どちらも
// ./rulesync.jsonc を読む。ファイル無し / パース失敗時は null を返し、呼び出し側それぞれの
// 安全側デフォルトに解釈を委ねる (下記コメント参照)。
type RulesyncConfig = { targets?: string[]; sources?: { skills?: string[] }[] };

function loadRulesyncConfig(): RulesyncConfig | null {
  if (!existsSync("rulesync.jsonc")) {
    return null;
  }
  try {
    // jsonc-parser の parse() は fault-tolerant で malformed でも throw しない。
    // errors 配列を渡し、構文エラーがあれば解決不能として null を返す (安全側へ倒す)。
    const errors: ParseError[] = [];
    const cfg = parseJsonc(readFileSync("rulesync.jsonc", "utf8"), errors) as RulesyncConfig;
    if (errors.length > 0) {
      return null;
    }
    return cfg;
  } catch (e) {
    // パース以外の予期しない失敗 (readFileSync の権限エラー等) も安全側 (null) に
    // 倒すが、デバッグのため原因はログに残す。
    console.error(`failed to load rulesync.jsonc: ${e}`);
    return null;
  }
}

const rulesyncConfig = loadRulesyncConfig();

// この install で「スコープ内」の skill 名集合を rulesyncConfig.sources[].skills から導出する。
// これにより
//   - target スコープ外で未取得 (claude の pr-review-respond 等) → 黙ってスキップ
//   - スコープ内なのに欠落 (upstream 破損)               → 従来通り throw
// を区別する。スコープ外と「想定外欠落」を取り違えてエラーを握りつぶさない。
// 設定を解決できない (ファイル無し / パース失敗 / 0 件) ときは null を返し、
// 後段で「全 skill をスコープ内」とみなして欠落時に throw する安全側へ倒す。
function loadExpectedSkills(): Set<string> | null {
  const set = new Set<string>();
  for (const source of rulesyncConfig?.sources ?? []) {
    for (const name of source?.skills ?? []) {
      set.add(name);
    }
  }
  if (set.size > 0) {
    return set;
  }
  // 現在は rulesync.jsonc の sources[].skills を省略し全 skill を取得する運用のため、
  // 明示列挙は通常 0 件になる。その場合は rulesync.lock の skills 一覧を期待値として
  // 読む — こうしないと後段の欠落検証 (configured skills missing ...) が丸ごと無効化
  // され、patch 対象を持たない skill の fetch/cache 事故による欠落が silently drop
  // される (レビュー指摘への対応)。
  const fromLock = loadExpectedSkillsFromLock();
  if (fromLock && fromLock.size > 0) {
    return fromLock;
  }
  // lock も解決できないときは null を返し、skillInScope 側で安全側
  // (in-scope = 欠落時 throw) に倒す。空集合で全 skill を out-of-scope (skip) にして
  // patch を黙って飛ばすより安全側に倒している。
  return null;
}

// rulesync.lock (cwd 相対) から「lock 済み skill 名」の集合を導出する。
// lock 構造: { sources: { "<owner>/<repo>": { skills: { "<name>": { integrity } } } } }
// ファイル無し / パース失敗時は null (呼び出し側で従来の安全側デフォルトへ)。
type RulesyncLock = { sources?: Record<string, { skills?: Record<string, unknown> }> };

function loadExpectedSkillsFromLock(): Set<string> | null {
  if (!existsSync("rulesync.lock")) {
    return null;
  }
  try {
    const lock = JSON.parse(readFileSync("rulesync.lock", "utf8")) as RulesyncLock;
    const set = new Set<string>();
    for (const source of Object.values(lock.sources ?? {})) {
      for (const name of Object.keys(source?.skills ?? {})) {
        set.add(name);
      }
    }
    return set;
  } catch (e) {
    console.error(`failed to load rulesync.lock for skill scope: ${e}`);
    return null;
  }
}

const expectedSkills = loadExpectedSkills();

// codex 向けパス書き換え patch (.codex/skills/ 等) は codexcli target のパイプラインにのみ
// 意味を持つ。以前はここを判別せず無条件適用していたため、claudecode パイプライン
// (rulesync-claude/ 経由) 実行時にも codex 向け patch が適用され、.claude/skills/ の生成物
// (research-practices / skill-builder) に本来存在しない `.codex/skills` 表記が混入していた。
// rulesyncConfig.targets に "codexcli" が含まれるかで判定し、設定を解決できない
// (ファイル無し / パース失敗) 場合は「書き換えない」(false) 側に倒す — claudecode 側に
// 誤って codex 向け patch を適用してしまう実害の方が、codexcli 側で patch を取りこぼす
// 実害より大きいため。
function isCodexTarget(): boolean {
  return rulesyncConfig?.targets?.includes("codexcli") ?? false;
}

// この path の skill が現 install のスコープ内か。呼び出し元 isRequiredTarget が
// startsWith(curatedPrefix) を保証するため curated path 前提で受ける。設定を解決
// できないときは安全側 (in-scope = 欠落時 throw) に倒し、退行を握りつぶさない。
function skillInScope(path: string) {
  // 設定を解決できない (rulesync.jsonc 無し / パース失敗 / sources[].skills が 0 件) ときは
  // expectedSkills=null となり、安全側 (in-scope = 欠落時 throw) に倒して退行を握りつぶさない。
  if (!expectedSkills) {
    return true;
  }
  const name = path.slice(curatedPrefix.length).split("/")[0];
  return expectedSkills.has(name);
}

const patches = [
  ".rulesync/skills/.curated/pr-review-respond/SKILL.md",
];

// NO_COLOR 等の env export を注入する対象。以前は SC2016 disable コメントも注入して
// いたが生成コピーが shellcheck 対象外になり削除したため、残る責務は env export のみ
// (旧名 shellcheckPatches から改名 — PR #153 review)。
const envExportPatches = [
  ".rulesync/skills/.curated/pr-review-respond/scripts/fetch_threads.sh",
];

type Replacement = {
  from: string;
  to: string;
  applied?: string;
  allowMultipleApplied?: boolean;
};

// Bun.file().exists() はディレクトリに対して常に false を返すため node:fs を使う。
const curatedRootExists = existsSync(".rulesync/skills/.curated");

// 取得対象 (expectedSkills) のうち curated に無い skill を検出して fail する。
// isRequiredTarget 経由のガードは patch 対象を持つ skill しか守れないため、
// 置換対象を持たない skill (linear-issue-driven-development / pr-conflict-resolver 等) の
// 取得欠落 (fetch 失敗等) はここで明示検証して握りつぶさない。
// curatedRootExists でゲートしないのは、install が完全に失敗して .curated 自体が
// 無い場合 (全 skill 欠落) も漏れなく fail させるため。
if (expectedSkills) {
  // ディレクトリだけでなく SKILL.md の存在まで確認する。install が中途終了して
  // 空ディレクトリだけ残ったケースも欠落として検出するため。
  const missing = [...expectedSkills].filter(
    (name) => !existsSync(`${curatedPrefix}${name}/SKILL.md`),
  );
  if (missing.length > 0) {
    throw new Error(
      `configured skills missing from curated install: ${missing.join(", ")}`,
    );
  }
}

function isRequiredTarget(path: string) {
  return (
    curatedRootExists &&
    path.startsWith(curatedPrefix) &&
    skillInScope(path)
  );
}

function countOccurrences(text: string, needle: string) {
  if (needle.length === 0) {
    throw new Error("empty patch marker is not allowed");
  }

  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + needle.length;
  }
}

function replacementAlreadyApplied(path: string, text: string, replacement: Replacement) {
  const marker = replacement.applied ?? replacement.to;
  const count = countOccurrences(text, marker);
  if (count > 1 && !replacement.allowMultipleApplied) {
    throw new Error(`patch applied marker is ambiguous in ${path}: ${marker}`);
  }
  return count > 0;
}

// patch 対象の本文を読む。欠落時はスコープ内なら upstream 破損として throw、
// スコープ外 (claude の未取得 skill 等) は null を返してスキップさせる。
// 欠落ガードを isRequiredTarget に一本化し、各 patch 関数での重複を避ける。
async function readPatchTarget(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (isRequiredTarget(path)) {
      throw new Error(`patch target not found: ${path}`);
    }
    return null;
  }
  return file.text();
}

async function patchFile(path: string, replacements: Replacement[]) {
  const initial = await readPatchTarget(path);
  if (initial === null) {
    return;
  }

  let text = initial;
  let changed = false;
  for (const replacement of replacements) {
    const { from, to } = replacement;
    if (text.includes(from)) {
      text = text.split(from).join(to);
      changed = true;
    } else if (!replacementAlreadyApplied(path, text, replacement)) {
      throw new Error(`patch pattern not found in ${path}: ${from}`);
    }
  }

  if (changed) {
    await Bun.write(path, text);
  }
}

async function patchPostgresQueryPatterns(path: string) {
  const text = await readPatchTarget(path);
  if (text === null) {
    return;
  }

  // Upstream examples can become userss/orderss after pluralization patches; normalize only those generated typos.
  const normalized = text
    .replace(/\busers{2,}\b/g, "users")
    .replace(/\borders{2,}\b/g, "orders");
  if (normalized !== text) {
    await Bun.write(path, normalized);
  }

  await patchFile(path, [
    { from: "SELECT * FROM user WHERE status = 'active';", to: "SELECT * FROM users WHERE status = 'active';" },
    { from: "SELECT id, name, email FROM user WHERE status = 'active';", to: "SELECT id, name, email FROM users WHERE status = 'active';" },
    { from: "SELECT id, (SELECT COUNT(*) FROM order WHERE order.user_id = user.id) FROM user;", to: "SELECT id, (SELECT COUNT(*) FROM orders WHERE orders.user_id = users.id) FROM users;" },
    { from: "SELECT u.id, COUNT(o.id) FROM user u LEFT JOIN order o ON o.user_id = u.id GROUP BY u.id;", to: "SELECT u.id, COUNT(o.id) FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id;" },
    { from: "SELECT * FROM user WHERE date_trunc('day', created_at) = '2023-01-01';", to: "SELECT * FROM users WHERE date_trunc('day', created_at) = '2023-01-01';" },
    { from: "SELECT * FROM user WHERE created_at >= '2023-01-01' AND created_at < '2023-01-02';", to: "SELECT * FROM users WHERE created_at >= '2023-01-01' AND created_at < '2023-01-02';" },
    { from: '    cursor.execute("SELECT name FROM user WHERE id = %s", (uid,))', to: '    cursor.execute("SELECT name FROM users WHERE id = %s", (uid,))' },
    { from: 'cursor.execute("SELECT id, name FROM user WHERE id = ANY(%s)", (list(user_ids),))', to: 'cursor.execute("SELECT id, name FROM users WHERE id = ANY(%s)", (list(user_ids),))' },
    { from: '# cursor.execute("SELECT id, name FROM user WHERE id IN %s", (tuple(user_ids),))', to: '# cursor.execute("SELECT id, name FROM users WHERE id IN %s", (tuple(user_ids),))' },
    { from: "SELECT id, name FROM user u\nWHERE EXISTS (SELECT 1 FROM order o WHERE o.user_id = u.id AND o.total > 100);", to: "SELECT id, name FROM users u\nWHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.total > 100);" },
  ]);
}

for (const path of patches) {
  const text = await readPatchTarget(path);
  if (text === null) {
    continue;
  }

  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    continue;
  }

  const frontmatter = match[1];
  if (frontmatter.includes("description: >-")) {
    continue;
  }

  const lines = frontmatter.split("\n");
  const index = lines.findIndex((line) => line.startsWith("description: "));
  if (index === -1) {
    continue;
  }

  const description = lines[index].slice("description: ".length);
  lines.splice(index, 1, "description: >-", `  ${description}`);

  const patched = text.replace(
    /^---\n[\s\S]*?\n---/,
    `---\n${lines.join("\n")}\n---`,
  );
  await Bun.write(path, patched);
}

const NO_COLOR_EXPORT = "export NO_COLOR=1 CLICOLOR=0 CLICOLOR_FORCE=0 GH_NO_UPDATE_NOTIFIER=1";
for (const path of envExportPatches) {
  const initial = await readPatchTarget(path);
  if (initial === null) {
    continue;
  }

  // gh の色付き出力が下流 jq を壊すのを防ぐ env export を注入する (挙動変更)。
  let text = initial;
  if (!text.includes(NO_COLOR_EXPORT)) {
    const injected = text.replace(
      "set -euo pipefail\n",
      `set -euo pipefail\n\n${NO_COLOR_EXPORT}\n`,
    );
    // アンカー不在で silent no-op すると注入が消える。patchFile の fail-loud 契約に
    // 揃え、未適用かつアンカー不在なら throw する (PR #153 review)。
    if (injected === text) {
      throw new Error(
        `could not inject NO_COLOR export into ${path} ("set -euo pipefail" anchor not found)`,
      );
    }
    text = injected;
  }

  await Bun.write(path, text);
}

for (const root of generatedRoots) {
  await patchFile(`${root}/pr-review-respond/scripts/prr`, [
    { from: 'exec "$SCRIPT_DIR/fetch_threads.sh" "$@"', to: 'exec bash "$SCRIPT_DIR/fetch_threads.sh" "$@"' },
    { from: 'exec "$SCRIPT_DIR/reply_thread.sh" "$@"', to: 'exec bash "$SCRIPT_DIR/reply_thread.sh" "$@"' },
    { from: 'exec "$SCRIPT_DIR/resolve_thread.sh" "$@"', to: 'exec bash "$SCRIPT_DIR/resolve_thread.sh" "$@"' },
    { from: 'exec "$SCRIPT_DIR/post_summary.sh" "$@"', to: 'exec bash "$SCRIPT_DIR/post_summary.sh" "$@"' },
    { from: 'exec "$SCRIPT_DIR/wait_ci.sh" "$@"', to: 'exec bash "$SCRIPT_DIR/wait_ci.sh" "$@"' },
  ]);

  // skill の呼び出し手順は upstream 原文が Claude Code の `${CLAUDE_SKILL_DIR}`
  // (Claude Code だけが定義する環境変数) 前提で書かれており、Claude 側ではそのまま
  // 正しい。Codex/OpenCode には同変数が無く、参照が残ると同梱スクリプトのパスが
  // 解決できず起動に失敗するため、codexcli パイプライン限定で `<skill-dir>`
  // プレースホルダに置換する。
  //
  // 以前は pr-review-respond の各呼び出し行を per-line で書き換えていたが、v0.9.0 で
  // pr-monitor / pr-conflict-resolver / issue-driven-development 等が新たにスクリプト
  // 呼び出し行を持ち、per-line パッチが取りこぼして .agents/ .opencode/ 生成物に
  // `${CLAUDE_SKILL_DIR}` が新規混入した (PR #153 review)。skill を列挙せず ${root}
  // 配下を再帰走査し、`bash "..."` / `python3 "..."` / prose 内の裸参照など形を問わず
  // 全 .md を一括置換することで、今後スクリプトを持つ skill が増えても追従不要にする。
  //
  // 実装と unit テストは ./rewrite-codex-skill-dir.ts に分離 (PR #153 review):
  //   - 再帰走査で全 .md を置換 (SKILL.md 直下限定だと references/ 由来の参照を取りこぼす)
  //   - 置換が起きた skill の SKILL.md に `<skill-dir>` 定義注記を挿入。旧 per-line パッチ
  //     が持っていた定義が一括置換で失われ、プレースホルダ literal 実行の誤誘導が起きるため。
  //     注記を置けない (SKILL.md 無し / frontmatter 想定外) 場合は fail-loud に throw する。
  //   - .md 以外 (scripts/ 等) に残った `${CLAUDE_SKILL_DIR}` は throw (実行時解決が要るため
  //     doc プレースホルダ置換で誤魔化さない)。
  if (isCodexTarget()) {
    // curated root 欠落は上流 (configured skills missing 検証) で明示 throw されるのが
    // 通常だが、rulesync.lock 欠落等の稀な経路では readdirSync が生 ENOENT で落ちる。
    // 原因の読める明示メッセージで先に throw する (root === curatedPrefix なので
    // モジュールレベルの curatedRootExists を再利用 — PR #153 review)。
    if (!curatedRootExists) {
      throw new Error(
        `curated skills root missing: ${root} (rulesync install did not produce it; cannot rewrite \${CLAUDE_SKILL_DIR} for codex targets)`,
      );
    }
    rewriteCodexSkillDir(root);
  }

  await patchFile(`${root}/mysql/references/primary-keys.md`, [
    {
      // 事実訂正のみ: MySQL の UUID() は v1 (time-based) を返し random ではない。
      // 直上行が既に UUID_TO_BIN(uuid, 1) の説明を持つため再掲はしない。
      from: "-- MySQL's UUID() returns UUIDv4 (random). For time-ordered IDs, use app-generated UUIDv7/ULID/Snowflake.",
      to: "-- MySQL's UUID() returns UUIDv1 (time-based), not random. For time-ordered IDs, use app-generated UUIDv7/ULID/Snowflake.",
    },
  ]);

  await patchFile(`${root}/mysql/references/row-locking-gotchas.md`, [
    {
      from: "description: Gap locks, next-key locks, and surprise escalation",
      to: "description: Gap locks and next-key locks; InnoDB does not automatically escalate row locks",
    },
  ]);

  await patchFile(`${root}/postgres/references/indexing.md`, [
    { from: "CREATE INDEX order_status_created_idx ON order (status, created_at);", to: "CREATE INDEX orders_status_created_idx ON orders (status, created_at);" },
    { from: "CREATE INDEX order_active_idx ON order (customer_id)", to: "CREATE INDEX orders_active_idx ON orders (customer_id)" },
    { from: "CREATE INDEX metadata_idx ON order USING GIN (metadata);", to: "CREATE INDEX orders_metadata_idx ON orders USING GIN (metadata);" },
  ]);

  await patchFile(`${root}/postgres/references/partitioning.md`, [
    { from: "CREATE TABLE order (\n", to: "CREATE TABLE orders (\n", allowMultipleApplied: true },
    { from: "CREATE TABLE order_us PARTITION OF order FOR VALUES IN ('us');", to: "CREATE TABLE orders_us PARTITION OF orders FOR VALUES IN ('us');" },
    { from: "CREATE TABLE order_eu PARTITION OF order FOR VALUES IN ('eu');", to: "CREATE TABLE orders_eu PARTITION OF orders FOR VALUES IN ('eu');" },
    { from: "CREATE TABLE order_default PARTITION OF order DEFAULT;", to: "CREATE TABLE orders_default PARTITION OF orders DEFAULT;" },
  ]);

  await patchPostgresQueryPatterns(`${root}/postgres/references/query-patterns.md`);

  await patchFile(`${root}/postgres/references/schema-design.md`, [
    { from: "CREATE TABLE user (\n", to: "CREATE TABLE users (\n" },
    { from: "CREATE TABLE order (\n", to: "CREATE TABLE orders (\n", allowMultipleApplied: true },
    { from: "CREATE INDEX order_customer_id_idx ON order (customer_id);", to: "CREATE INDEX orders_customer_id_idx ON orders (customer_id);" },
    { from: "e.g., `order_status_check`", to: "e.g., `orders_status_check`" },
    // CREATE TABLE 例を予約語回避で複数形にしているので、命名規則の記述も複数形に揃える
    // (singular のままだと例と矛盾する、というレビュー指摘への対応)。
    { from: "- Tables: singular snake_case (`user_account`, `order_item`)", to: "- Tables: plural snake_case (`users`, `order_items`)" },
    // FK 例が存在しない singular table (customer) を参照し、かつ plural 命名規則とも
    // 矛盾していたため、参照先 customers テーブルを定義し plural に揃えて self-contained にする。
    {
      from: "CREATE TABLE orders (\n  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  customer_id BIGINT NOT NULL REFERENCES customer(id) ON DELETE CASCADE\n);",
      to: "CREATE TABLE customers (\n  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY\n);\nCREATE TABLE orders (\n  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE\n);",
    },
  ]);

  // research-practices の upstream 原文は `.claude/skills/research-practices/` であり、
  // Claude 側ではそのまま正しいパスなので claudecode パイプラインには適用しない。
  // codexcli パイプラインでのみ `.agents/skills/research-practices/` に書き換える
  // (rulesync 9.1.1 が codexcli target の skills を .agents/skills に出力するため)。
  if (isCodexTarget()) {
    await patchFile(`${root}/research-practices/assets/research-report-template.md`, [
      { from: ".claude/skills/research-practices/", to: ".agents/skills/research-practices/" },
    ]);
  }

  // skill-builder の consumer プロジェクト形式の説明も同様に codex 向けパス書き換えを
  // codexcli パイプライン限定にする。claudecode パイプラインでは upstream 原文
  // (`.claude/skills/<name>/SKILL.md`) をそのまま使う。
  if (isCodexTarget()) {
    await patchFile(`${root}/skill-builder/SKILL.md`, [
      { from: "`.claude/skills/<name>/SKILL.md` または top-level `<name>/SKILL.md`", to: "`.agents/skills/<name>/SKILL.md` または rulesync source `skills/<name>/SKILL.md`" },
      { from: "- consumer プロジェクト形式: `.claude/skills/<name>/SKILL.md`", to: "- consumer プロジェクト形式: `.agents/skills/<name>/SKILL.md`" },
    ]);
  }

  // evals ファイル拡張子の文言修正 (.json → .jsonl) はパスと無関係な事実訂正なので
  // codexcli / claudecode 両ターゲット共通で適用する。
  await patchFile(`${root}/skill-builder/SKILL.md`, [
    { from: "`evals/<skill>-trigger-results-<date>.json` + description 改訂案", to: "`evals/<skill>-trigger-results-<date>.jsonl` (JSON Lines) + description 改訂案" },
  ]);

  await patchFile(`${root}/test-review/references/ai-generated.md`, [
    { from: "フォールバックの順序、タイブレーク", to: "フォールバックの順序、同点時の優先順" },
  ]);

  await patchFile(`${root}/test-review/references/data-stack.md`, [
    { from: "モデルの升バンプ", to: "モデルのメジャーバンプ" },
  ]);
}

import { existsSync, readFileSync } from "node:fs";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

const generatedRoots = [
  ".rulesync/skills/.curated",
];

const curatedPrefix = ".rulesync/skills/.curated/";

// この install で「スコープ内」の skill 名集合を rulesync.jsonc (cwd 相対) の
// sources[].skills から導出する。codex は repo 直下、claude は rulesync-claude/ を
// cwd に走り、どちらも ./rulesync.jsonc を読む。これにより
//   - target スコープ外で未取得 (claude の pr-review-respond 等) → 黙ってスキップ
//   - スコープ内なのに欠落 (upstream 破損)               → 従来通り throw
// を区別する。スコープ外と「想定外欠落」を取り違えてエラーを握りつぶさない。
// 設定を解決できない (ファイル無し / パース失敗 / 0 件) ときは null を返し、
// 後段で「全 skill をスコープ内」とみなして欠落時に throw する安全側へ倒す。
type RulesyncConfig = { sources?: { skills?: string[] }[] };

function loadExpectedSkills(): Set<string> | null {
  if (!existsSync("rulesync.jsonc")) {
    return null;
  }
  let cfg: RulesyncConfig | undefined;
  try {
    // jsonc-parser の parse() は fault-tolerant で malformed でも throw しない。
    // errors 配列を渡し、構文エラーがあれば解決不能として null を返す (安全側へ倒す)。
    const errors: ParseError[] = [];
    cfg = parseJsonc(readFileSync("rulesync.jsonc", "utf8"), errors) as RulesyncConfig;
    if (errors.length > 0) {
      return null;
    }
  } catch (e) {
    // パース以外の予期しない失敗 (readFileSync の権限エラー等) も安全側 (null) に
    // 倒すが、デバッグのため原因はログに残す。
    console.error(`failed to load rulesync.jsonc for skill scope: ${e}`);
    return null;
  }
  const set = new Set<string>();
  for (const source of cfg?.sources ?? []) {
    for (const name of source?.skills ?? []) {
      set.add(name);
    }
  }
  return set.size > 0 ? set : null;
}

const expectedSkills = loadExpectedSkills();

// この path の skill が現 install のスコープ内か。設定を解決できないときは
// 安全側 (in-scope = 欠落時 throw) に倒し、退行を握りつぶさない。
function skillInScope(path: string) {
  // 防御的ガード: 現状 isRequiredTarget が先に startsWith を確認するため到達しないが、
  // 別コンテキストから直接呼ばれた場合、curated 配下でないパスは「スコープ対象の
  // skill ではない」ので out-of-scope (false) を返す。
  if (!path.startsWith(curatedPrefix)) {
    return false;
  }
  // 設定を解決できない場合は安全側 (in-scope = 欠落時 throw) に倒す。
  if (!expectedSkills) {
    return true;
  }
  const name = path.slice(curatedPrefix.length).split("/")[0];
  return expectedSkills.has(name);
}

const patches = [
  ".rulesync/skills/.curated/pr-review-respond/SKILL.md",
];

const shellcheckPatches = [
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

async function patchFile(path: string, replacements: Replacement[]) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    // スコープ内 (= 取得済みのはず) なのに欠落していれば upstream 破損として throw。
    // スコープ外 (claude の未取得 skill 等) は黙ってスキップ。判定は isRequiredTarget に一本化。
    if (isRequiredTarget(path)) {
      throw new Error(`patch target not found: ${path}`);
    }
    return;
  }

  let text = await file.text();
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
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (isRequiredTarget(path)) {
      throw new Error(`patch target not found: ${path}`);
    }
    return;
  }

  let text = await file.text();
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
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (isRequiredTarget(path)) {
      throw new Error(`patch target not found: ${path}`);
    }
    continue;
  }

  const text = await file.text();
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

for (const path of shellcheckPatches) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (isRequiredTarget(path)) {
      throw new Error(`patch target not found: ${path}`);
    }
    continue;
  }

  let text = await file.text();
  if (!text.includes("export NO_COLOR=1 CLICOLOR=0 CLICOLOR_FORCE=0 GH_NO_UPDATE_NOTIFIER=1")) {
    text = text.replace(
      "set -euo pipefail\n",
      "set -euo pipefail\n\nexport NO_COLOR=1 CLICOLOR=0 CLICOLOR_FORCE=0 GH_NO_UPDATE_NOTIFIER=1\n",
    );
  }

  if (!text.includes("# shellcheck disable=SC2016\n  resp=$(gh api graphql")) {
    text = text.replace(
      "  resp=$(gh api graphql",
      "  # shellcheck disable=SC2016\n  resp=$(gh api graphql",
    );
  }

  if (!text.includes("# shellcheck disable=SC2016\nvendor_filter='")) {
    text = text.replace(
      "\nvendor_filter='",
      "\n# shellcheck disable=SC2016\nvendor_filter='",
    );
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

  await patchFile(`${root}/pr-review-respond/SKILL.md`, [
    {
      from: 'すべて `bash "${CLAUDE_SKILL_DIR}/scripts/prr" <subcommand> <args>` で呼び出す:',
      to: 'すべて、Codex が表示したこの skill ディレクトリから `scripts/prr` を解決し、`bash <skill-dir>/scripts/prr <subcommand> <args>` で呼び出す:',
    },
    { from: 'bash "${CLAUDE_SKILL_DIR}/scripts/prr" fetch <PR>', to: 'bash <skill-dir>/scripts/prr fetch <PR>' },
    { from: 'bash "${CLAUDE_SKILL_DIR}/scripts/prr" reply <PR> <root-comment-id> <body-file>', to: 'bash <skill-dir>/scripts/prr reply <PR> <root-comment-id> <body-file>' },
    { from: 'bash "${CLAUDE_SKILL_DIR}/scripts/prr" resolve <PR> <root-comment-id> [body-file]', to: 'bash <skill-dir>/scripts/prr resolve <PR> <root-comment-id> [body-file]' },
    { from: 'bash "${CLAUDE_SKILL_DIR}/scripts/prr" summary <PR> <body-file>', to: 'bash <skill-dir>/scripts/prr summary <PR> <body-file>' },
    { from: 'bash "${CLAUDE_SKILL_DIR}/scripts/prr" wait-ci <PR>', to: 'bash <skill-dir>/scripts/prr wait-ci <PR>' },
  ]);

  await patchFile(`${root}/mysql/references/primary-keys.md`, [
    {
      from: "-- MySQL's UUID() returns UUIDv4 (random). For time-ordered IDs, use app-generated UUIDv7/ULID/Snowflake.",
      to: "-- MySQL's UUID() returns UUIDv1 (time-based), never random; UUID_TO_BIN(uuid, 1) reorders v1 bytes for better index locality.",
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

  await patchFile(`${root}/research-practices/assets/research-report-template.md`, [
    { from: ".claude/skills/research-practices/", to: ".codex/skills/research-practices/" },
  ]);

  await patchFile(`${root}/skill-builder/SKILL.md`, [
    { from: "`.claude/skills/<name>/SKILL.md` または top-level `<name>/SKILL.md`", to: "`.codex/skills/<name>/SKILL.md` または rulesync source `skills/<name>/SKILL.md`" },
    { from: "- consumer プロジェクト形式: `.claude/skills/<name>/SKILL.md`", to: "- consumer プロジェクト形式: `.codex/skills/<name>/SKILL.md`" },
    { from: "`evals/<skill>-trigger-results-<date>.json` + description 改訂案", to: "`evals/<skill>-trigger-results-<date>.jsonl` (JSON Lines) + description 改訂案" },
  ]);

  await patchFile(`${root}/test-review/references/ai-generated.md`, [
    { from: "フォールバックの順序、タイブレーク", to: "フォールバックの順序、同点時の優先順" },
  ]);

  await patchFile(`${root}/test-review/references/data-stack.md`, [
    { from: "モデルの升バンプ", to: "モデルのメジャーバンプ" },
  ]);
}

const generatedRoots = [
  ".rulesync/skills/.curated",
  ".codex/skills",
];

const patches = [
  ".rulesync/skills/.curated/pr-review-respond/SKILL.md",
  ".codex/skills/pr-review-respond/SKILL.md",
];

const shellcheckPatches = [
  ".rulesync/skills/.curated/pr-review-respond/scripts/fetch_threads.sh",
  ".codex/skills/pr-review-respond/scripts/fetch_threads.sh",
];

type Replacement = {
  from: string;
  to: string;
};

const curatedRootExists = await Bun.file(".rulesync/skills/.curated").exists();

function isRequiredTarget(path: string) {
  return curatedRootExists && path.startsWith(".rulesync/skills/.curated/");
}

async function patchFile(path: string, replacements: Replacement[], required = false) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (required) {
      throw new Error(`patch target not found: ${path}`);
    }
    return;
  }

  let text = await file.text();
  let changed = false;
  for (const { from, to } of replacements) {
    if (text.includes(from)) {
      text = text.split(from).join(to);
      changed = true;
    } else if (!text.includes(to)) {
      throw new Error(`patch pattern not found in ${path}: ${from}`);
    }
  }

  if (changed) {
    await Bun.write(path, text);
  }
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
  const required = root.startsWith(".rulesync/skills/.curated") && curatedRootExists;
  await patchFile(`${root}/pr-review-respond/scripts/prr`, [
    { from: 'exec "$SCRIPT_DIR/fetch_threads.sh" "$@"', to: 'exec bash "$SCRIPT_DIR/fetch_threads.sh" "$@"' },
    { from: 'exec "$SCRIPT_DIR/reply_thread.sh" "$@"', to: 'exec bash "$SCRIPT_DIR/reply_thread.sh" "$@"' },
    { from: 'exec "$SCRIPT_DIR/resolve_thread.sh" "$@"', to: 'exec bash "$SCRIPT_DIR/resolve_thread.sh" "$@"' },
    { from: 'exec "$SCRIPT_DIR/post_summary.sh" "$@"', to: 'exec bash "$SCRIPT_DIR/post_summary.sh" "$@"' },
    { from: 'exec "$SCRIPT_DIR/wait_ci.sh" "$@"', to: 'exec bash "$SCRIPT_DIR/wait_ci.sh" "$@"' },
  ], required);

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
  ], required);

  await patchFile(`${root}/mysql/references/primary-keys.md`, [
    {
      from: "-- MySQL's UUID() returns UUIDv4 (random). For time-ordered IDs, use app-generated UUIDv7/ULID/Snowflake.",
      to: "-- MySQL's UUID() returns UUIDv1 (time-based). UUID_TO_BIN(uuid, 1) reorders UUIDv1 bytes for better locality.\n-- For random IDs, use UUID_TO_BIN(UUID(), 0) or app-generated UUIDv4; for ordered IDs, prefer app-generated UUIDv7/ULID/Snowflake.",
    },
  ], required);

  await patchFile(`${root}/mysql/references/row-locking-gotchas.md`, [
    {
      from: "description: Gap locks, next-key locks, and surprise escalation",
      to: "description: Gap locks and next-key locks; InnoDB does not automatically escalate row locks",
    },
  ], required);

  await patchFile(`${root}/postgres/references/indexing.md`, [
    { from: "CREATE INDEX order_status_created_idx ON order (status, created_at);", to: "CREATE INDEX orders_status_created_idx ON orders (status, created_at);" },
    { from: "CREATE INDEX order_active_idx ON order (customer_id)", to: "CREATE INDEX orders_active_idx ON orders (customer_id)" },
    { from: "CREATE INDEX metadata_idx ON order USING GIN (metadata);", to: "CREATE INDEX orders_metadata_idx ON orders USING GIN (metadata);" },
  ], required);

  await patchFile(`${root}/postgres/references/partitioning.md`, [
    { from: "CREATE TABLE order (\n", to: "CREATE TABLE orders (\n" },
    { from: "CREATE TABLE order_us PARTITION OF order FOR VALUES IN ('us');", to: "CREATE TABLE orders_us PARTITION OF orders FOR VALUES IN ('us');" },
    { from: "CREATE TABLE order_eu PARTITION OF order FOR VALUES IN ('eu');", to: "CREATE TABLE orders_eu PARTITION OF orders FOR VALUES IN ('eu');" },
    { from: "CREATE TABLE order_default PARTITION OF order DEFAULT;", to: "CREATE TABLE orders_default PARTITION OF orders DEFAULT;" },
  ], required);

  await patchFile(`${root}/postgres/references/query-patterns.md`, [
    { from: "FROM user", to: "FROM users" },
    { from: "FROM order", to: "FROM orders" },
    { from: "JOIN order", to: "JOIN orders" },
    { from: "order.user_id", to: "orders.user_id" },
    { from: "user.id", to: "users.id" },
  ], required);

  await patchFile(`${root}/postgres/references/schema-design.md`, [
    { from: "CREATE TABLE user (\n", to: "CREATE TABLE users (\n" },
    { from: "CREATE TABLE order (\n", to: "CREATE TABLE orders (\n" },
    { from: "CREATE INDEX order_customer_id_idx ON order (customer_id);", to: "CREATE INDEX orders_customer_id_idx ON orders (customer_id);" },
    { from: "e.g., `order_status_check`", to: "e.g., `orders_status_check`" },
  ], required);

  await patchFile(`${root}/research-practices/assets/research-report-template.md`, [
    { from: ".claude/skills/research-practices/", to: ".codex/skills/research-practices/" },
  ], required);

  await patchFile(`${root}/skill-builder/SKILL.md`, [
    { from: "`.claude/skills/<name>/SKILL.md` または top-level `<name>/SKILL.md`", to: "`.codex/skills/<name>/SKILL.md` または rulesync source `skills/<name>/SKILL.md`" },
    { from: "- consumer プロジェクト形式: `.claude/skills/<name>/SKILL.md`", to: "- consumer プロジェクト形式: `.codex/skills/<name>/SKILL.md`" },
    { from: "skill カタログ形式 (rulesync 配布元): `skills/<name>/SKILL.md`", to: "skill カタログ形式 (rulesync 配布元): `skills/<name>/SKILL.md`" },
    { from: "`evals/<skill>-trigger-results-<date>.json` + description 改訂案", to: "`evals/<skill>-trigger-results-<date>.jsonl` (JSON Lines) + description 改訂案" },
  ], required);

  await patchFile(`${root}/test-review/references/ai-generated.md`, [
    { from: "フォールバックの順序、タイブレーク", to: "フォールバックの順序、同点時の優先順" },
  ], required);

  await patchFile(`${root}/test-review/references/data-stack.md`, [
    { from: "モデルの升バンプ", to: "モデルのメジャーバンプ" },
  ], required);
}

const patches = [
  ".rulesync/skills/.curated/pr-review-respond/SKILL.md",
];

const shellcheckPatches = [
  ".rulesync/skills/.curated/pr-review-respond/scripts/fetch_threads.sh",
];

for (const path of patches) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
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
    continue;
  }

  let text = await file.text();
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

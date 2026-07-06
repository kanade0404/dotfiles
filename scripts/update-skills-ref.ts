import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser";

// .github/workflows/skills-update.yml (kanade0404/skills の reusable workflow
// consumer-update.yml 経由) が解決した最新タグを SKILLS_TAG で受け取り、
// rulesync.jsonc / rulesync-claude/rulesync.jsonc の kanade0404/skills source の
// "ref" を書き換える。jsonc-parser の modify/applyEdits を使うことで、両ファイルに
// 付いたコメントやインデントを壊さず最小差分で更新できる (JSON.parse + 再シリアライズ
// だとコメントが消える)。
//
// 冪等性: "ref" が既存なら値を上書き、未設定なら "transport" の直後に新規追加される
// (jsonc-parser の modify がプロパティ位置を解決する)。どちらの状態から実行しても
// 同じ結果に収束する。
const SKILLS_SOURCE_URL = "https://github.com/kanade0404/skills.git";

const targetFiles = ["rulesync.jsonc", "rulesync-claude/rulesync.jsonc"];

const tag = process.env.SKILLS_TAG;
if (!tag) {
  throw new Error("SKILLS_TAG is not set");
}
// reusable workflow 側は `^v[0-9]+\.[0-9]+\.[0-9]+$` にマッチするタグしか解決しない
// 契約だが、pin 書き換え先が想定外の値になる事故を防ぐため、このスクリプト単体でも
// 同じ形式を強制する (安全側チェックの二重化)。
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(`unexpected SKILLS_TAG format: ${tag}`);
}

for (const file of targetFiles) {
  if (!existsSync(file)) {
    throw new Error(`missing rulesync config: ${file}`);
  }

  const text = readFileSync(file, "utf8");
  const root = parseTree(text);
  if (!root) {
    throw new Error(`failed to parse ${file}`);
  }

  const sourcesNode = findNodeAtLocation(root, ["sources"]);
  if (!sourcesNode || sourcesNode.type !== "array" || !sourcesNode.children) {
    throw new Error(`"sources" array not found in ${file}`);
  }

  const index = sourcesNode.children.findIndex((child) => {
    const sourceNode = findNodeAtLocation(child, ["source"]);
    return sourceNode?.value === SKILLS_SOURCE_URL;
  });
  if (index < 0) {
    throw new Error(`source ${SKILLS_SOURCE_URL} not found in ${file}`);
  }

  const edits = modify(text, ["sources", index, "ref"], tag, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  const updated = applyEdits(text, edits);
  if (updated !== text) {
    writeFileSync(file, updated);
    console.log(`updated ${file}: sources[${index}].ref = ${tag}`);
  } else {
    console.log(`${file} already up to date (${tag})`);
  }
}

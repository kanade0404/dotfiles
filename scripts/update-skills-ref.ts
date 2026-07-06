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
//
// assertValidTag / updateSkillsRef はファイル I/O を持たない純粋関数として切り出して
// あり、scripts/update-skills-ref.test.ts から直接ユニットテストできる (実ファイルへの
// 書き込みは import.meta.main ブロックの CLI 実行部にのみ閉じる)。
export const SKILLS_SOURCE_URL = "https://github.com/kanade0404/skills.git";

const targetFiles = ["rulesync.jsonc", "rulesync-claude/rulesync.jsonc"];

// reusable workflow 側は `^v[0-9]+\.[0-9]+\.[0-9]+$` にマッチするタグしか解決しない
// 契約だが、pin 書き換え先が想定外の値になる事故を防ぐため、このスクリプト単体でも
// 同じ形式を強制する (安全側チェックの二重化)。
export function assertValidTag(tag: string | undefined): asserts tag is string {
  if (!tag) {
    throw new Error("SKILLS_TAG is not set");
  }
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`unexpected SKILLS_TAG format: ${tag}`);
  }
}

// jsonc テキストを受け取り、sources[] のうち source === sourceUrl な要素の "ref" を
// tag へ書き換えたテキストを返す。ファイルには一切触れない (呼び出し側の責務)。
export function updateSkillsRef(
  text: string,
  tag: string,
  sourceUrl: string = SKILLS_SOURCE_URL,
): string {
  const root = parseTree(text);
  if (!root) {
    throw new Error("failed to parse jsonc text");
  }

  const sourcesNode = findNodeAtLocation(root, ["sources"]);
  if (!sourcesNode || sourcesNode.type !== "array" || !sourcesNode.children) {
    throw new Error('"sources" array not found');
  }

  const index = sourcesNode.children.findIndex((child) => {
    const sourceNode = findNodeAtLocation(child, ["source"]);
    return sourceNode?.value === sourceUrl;
  });
  if (index < 0) {
    throw new Error(`source ${sourceUrl} not found`);
  }

  const edits = modify(text, ["sources", index, "ref"], tag, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  return applyEdits(text, edits);
}

// CLI エントリポイント。`bun scripts/update-skills-ref.ts` として実行されたときのみ
// 実ファイルを読み書きする (import.meta.main ガードにより、テストからの import では
// 副作用を起こさない)。
if (import.meta.main) {
  const tag = process.env.SKILLS_TAG;
  assertValidTag(tag);

  for (const file of targetFiles) {
    if (!existsSync(file)) {
      throw new Error(`missing rulesync config: ${file}`);
    }

    const text = readFileSync(file, "utf8");
    const updated = updateSkillsRef(text, tag);
    if (updated !== text) {
      writeFileSync(file, updated);
      console.log(`updated ${file}: ref = ${tag}`);
    } else {
      console.log(`${file} already up to date (${tag})`);
    }
  }
}

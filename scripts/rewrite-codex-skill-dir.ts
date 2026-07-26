import { readdirSync, readFileSync, writeFileSync } from "node:fs";

// Claude Code の `${CLAUDE_SKILL_DIR}` 環境変数は Claude Code だけが定義する。
// Codex/OpenCode 生成物に残ると同梱スクリプトのパスが解決できず起動に失敗するため、
// codexcli パイプラインでのみ `<skill-dir>` プレースホルダに置換する。
export const CLAUDE_SKILL_DIR_MARKER = "${CLAUDE_SKILL_DIR}";
export const SKILL_DIR_PLACEHOLDER = "<skill-dir>";

// 置換後の SKILL.md には frontmatter 直後にこの定義注記を挿入し、`<skill-dir>` が
// 何を指すか (= literal 実行してはいけないプレースホルダ) を明示する。一括置換だけだと
// 旧 per-line パッチが持っていた定義が失われ、プレースホルダ直接実行の誤誘導が起きる。
export const SKILL_DIR_NOTE =
  "\n> **注 (Codex/OpenCode)**: 本文中の `<skill-dir>` は、この skill が配置された" +
  "ディレクトリ (Codex が提示するパス) を指すプレースホルダ。`scripts/…` はそこから" +
  "解決すること — `<skill-dir>` をそのまま literal 実行しない。\n";

// 注記が既に挿入済みかを判定する marker (二重挿入ガード / テスト用に共有)。
export const SKILL_DIR_NOTE_MARKER = "本文中の `<skill-dir>` は";

const FRONTMATTER_RE = /^(---\n[\s\S]*?\n---\n)/;

function isMarkdown(name: string): boolean {
  // 大文字拡張子 (README.MD 等) も markdown として扱う (case-insensitive)。
  return name.toLowerCase().endsWith(".md");
}

// skill ディレクトリ 1 つを再帰走査し、`${CLAUDE_SKILL_DIR}` を含む .md を置換する。
// 置換後の .md に `<skill-dir>` が含まれる (= references/*.md だけの場合も含む) なら
// その skill の SKILL.md に定義注記を挿入する。
function rewriteOneSkill(skillDir: string): void {
  let skillMdPath: string | null = null;
  // 注記の要否は「この run で置換したか」ではなく post-state (置換後に .md が
  // `<skill-dir>` を含むか) で判定する。walk は .md を見つけ次第 eager write するため、
  // 後続ファイルで throw した run の後に原因を直して再実行すると、マーカーは既に消えて
  // おり this-run 判定 (旧 `rewrote`) では注記が silent 欠落する (PR #153 review)。
  let sawPlaceholder = false;

  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${ent.name}`;
      // symlink は target 種別が Dirent に反映されず readFileSync が EISDIR で
      // 生落ちしうるため明示 skip する (curated cache に現状 symlink は無い)。
      if (ent.isSymbolicLink()) {
        continue;
      }
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (dir === skillDir && ent.name === "SKILL.md") {
        skillMdPath = p;
      }
      const text = readFileSync(p, "utf8");
      const md = isMarkdown(ent.name);
      let finalText = text;
      if (text.includes(CLAUDE_SKILL_DIR_MARKER)) {
        if (!md) {
          // scripts/ 等の非 .md に残った場合は doc プレースホルダ置換では正しく扱えない
          // (実行時に解決が要る) ため、silent に壊れたパスを出荷せず fail-loud にする。
          throw new Error(
            `residual ${CLAUDE_SKILL_DIR_MARKER} in non-markdown codex skill file: ${p} — the ${SKILL_DIR_PLACEHOLDER} rewrite only covers .md; handle this file deliberately (Codex/OpenCode does not define CLAUDE_SKILL_DIR)`,
          );
        }
        finalText = text.split(CLAUDE_SKILL_DIR_MARKER).join(SKILL_DIR_PLACEHOLDER);
        writeFileSync(p, finalText);
      }
      if (md && finalText.includes(SKILL_DIR_PLACEHOLDER)) {
        sawPlaceholder = true;
      }
    }
  };
  walk(skillDir);

  if (!sawPlaceholder) {
    return;
  }

  // `<skill-dir>` を出荷するなら SKILL.md に定義注記を必ず入れる。入れられない
  // (SKILL.md が無い / frontmatter 形が想定外) なら注記欠落の silent 出荷を避けて throw。
  if (skillMdPath === null) {
    throw new Error(
      `codex skill under ${skillDir} contains ${SKILL_DIR_PLACEHOLDER} but has no SKILL.md to host the definition note`,
    );
  }
  const skillMd = readFileSync(skillMdPath, "utf8");
  if (!skillMd.includes(SKILL_DIR_NOTE_MARKER)) {
    const noted = skillMd.replace(FRONTMATTER_RE, `$1${SKILL_DIR_NOTE}`);
    if (noted === skillMd) {
      throw new Error(
        `could not insert ${SKILL_DIR_PLACEHOLDER} definition note into ${skillMdPath} (frontmatter block not found at file head)`,
      );
    }
    writeFileSync(skillMdPath, noted);
  }
}

// codex 生成物の root (例 .rulesync/skills/.curated) 直下の各 skill を処理する。
export function rewriteCodexSkillDir(root: string): void {
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (ent.isSymbolicLink() || !ent.isDirectory()) {
      continue;
    }
    rewriteOneSkill(`${root}/${ent.name}`);
  }
}

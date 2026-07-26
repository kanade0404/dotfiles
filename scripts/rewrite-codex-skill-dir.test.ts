import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_SKILL_DIR_MARKER,
  rewriteCodexSkillDir,
  SKILL_DIR_NOTE_MARKER,
  SKILL_DIR_PLACEHOLDER,
} from "./rewrite-codex-skill-dir.ts";

const FRONTMATTER = "---\nname: sample\ndescription: x\n---\n";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-skill-dir-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeSkill(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("rewriteCodexSkillDir", () => {
  test("SKILL.md のマーカーを置換し、frontmatter 直後に定義注記を挿入する", () => {
    const dir = makeSkill("pr-monitor");
    const skillMd = join(dir, "SKILL.md");
    writeFileSync(skillMd, `${FRONTMATTER}\nbash "${CLAUDE_SKILL_DIR_MARKER}/scripts/prm" status\n`);

    rewriteCodexSkillDir(root);

    const out = readFileSync(skillMd, "utf8");
    expect(out).not.toContain(CLAUDE_SKILL_DIR_MARKER);
    expect(out).toContain(`bash "${SKILL_DIR_PLACEHOLDER}/scripts/prm" status`);
    expect(out).toContain(SKILL_DIR_NOTE_MARKER);
    // 注記は frontmatter 直後 (最初の閉じ --- の後) に入る。
    const noteIdx = out.indexOf(SKILL_DIR_NOTE_MARKER);
    const fmEnd = out.indexOf("\n---\n") + "\n---\n".length;
    expect(noteIdx).toBeGreaterThanOrEqual(fmEnd);
  });

  test("再実行しても注記を二重挿入せず、マーカーも残さない (冪等)", () => {
    const dir = makeSkill("pr-monitor");
    const skillMd = join(dir, "SKILL.md");
    writeFileSync(skillMd, `${FRONTMATTER}\n"${CLAUDE_SKILL_DIR_MARKER}/scripts/prm"\n`);

    rewriteCodexSkillDir(root);
    const first = readFileSync(skillMd, "utf8");
    rewriteCodexSkillDir(root);
    const second = readFileSync(skillMd, "utf8");

    // 2 回目は置換対象 (マーカー) が無いので no-op。ファイルは変わらない。
    expect(second).toBe(first);
    const occurrences = second.split(SKILL_DIR_NOTE_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });

  test("references/*.md だけにマーカーがあっても SKILL.md に注記を入れる", () => {
    const dir = makeSkill("pr-conflict-resolver");
    const skillMd = join(dir, "SKILL.md");
    writeFileSync(skillMd, `${FRONTMATTER}\n本文\n`);
    mkdirSync(join(dir, "references"), { recursive: true });
    const ref = join(dir, "references", "guide.md");
    writeFileSync(ref, `see "${CLAUDE_SKILL_DIR_MARKER}/scripts/verify.sh"\n`);

    rewriteCodexSkillDir(root);

    expect(readFileSync(ref, "utf8")).not.toContain(CLAUDE_SKILL_DIR_MARKER);
    expect(readFileSync(ref, "utf8")).toContain(`"${SKILL_DIR_PLACEHOLDER}/scripts/verify.sh"`);
    // SKILL.md 自体にマーカーは無かったが、skill 配下で置換が起きたので注記が入る。
    expect(readFileSync(skillMd, "utf8")).toContain(SKILL_DIR_NOTE_MARKER);
  });

  test("非 .md (scripts/*.sh) にマーカーが残ると throw する", () => {
    const dir = makeSkill("issue-driven-development");
    writeFileSync(join(dir, "SKILL.md"), `${FRONTMATTER}\n本文\n`);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "acquire-lock.sh"), `path="${CLAUDE_SKILL_DIR_MARKER}/scripts"\n`);

    expect(() => rewriteCodexSkillDir(root)).toThrow(/non-markdown/);
  });

  test("frontmatter が無い SKILL.md で置換が起きたら注記を置けず throw する", () => {
    const dir = makeSkill("weird");
    const skillMd = join(dir, "SKILL.md");
    // frontmatter で始まらない → 注記挿入の replace が no-op になる。
    writeFileSync(skillMd, `# heading\nbash "${CLAUDE_SKILL_DIR_MARKER}/scripts/x"\n`);

    expect(() => rewriteCodexSkillDir(root)).toThrow(/definition note/);
  });

  test("大文字拡張子 (.MD) も markdown として置換する", () => {
    const dir = makeSkill("upper");
    writeFileSync(join(dir, "SKILL.md"), FRONTMATTER);
    const readme = join(dir, "README.MD");
    writeFileSync(readme, `"${CLAUDE_SKILL_DIR_MARKER}/scripts/x"\n`);

    expect(() => rewriteCodexSkillDir(root)).not.toThrow();
    expect(readFileSync(readme, "utf8")).not.toContain(CLAUDE_SKILL_DIR_MARKER);
  });
});

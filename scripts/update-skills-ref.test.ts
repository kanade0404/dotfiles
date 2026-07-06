import { describe, test, expect } from "bun:test";
import { assertValidTag, updateSkillsRef, SKILLS_SOURCE_URL } from "./update-skills-ref.ts";

const fixtureWithoutRef = `{
  // sample comment kept to verify jsonc comments survive the rewrite
  "$schema": "https://example.invalid/schema.json",
  "targets": ["codexcli"],
  "sources": [
    {
      "source": "https://github.com/kanade0404/skills.git",
      "transport": "git"
    },
    {
      "source": "https://github.com/planetscale/database-skills.git",
      "transport": "git"
    }
  ]
}
`;

const fixtureWithRef = `{
  "$schema": "https://example.invalid/schema.json",
  "sources": [
    {
      "source": "https://github.com/kanade0404/skills.git",
      "transport": "git",
      "ref": "v0.6.0"
    },
    {
      "source": "https://github.com/planetscale/database-skills.git",
      "transport": "git"
    }
  ]
}
`;

describe("assertValidTag", () => {
  test("SKILLS_TAG 未設定なら throw する", () => {
    expect(() => assertValidTag(undefined)).toThrow("SKILLS_TAG is not set");
  });

  test("空文字なら throw する", () => {
    expect(() => assertValidTag("")).toThrow("SKILLS_TAG is not set");
  });

  test.each(["master", "v1.2", "1.2.3", "v1.2.3-rc1", "v1.2.3 "])(
    "vX.Y.Z 形式でない %s は throw する",
    (tag) => {
      expect(() => assertValidTag(tag)).toThrow(/unexpected SKILLS_TAG format/);
    },
  );

  test("vX.Y.Z 形式なら throw しない", () => {
    expect(() => assertValidTag("v0.6.1")).not.toThrow();
  });
});

describe("updateSkillsRef", () => {
  test("\"ref\" が無ければ transport の直後に新規追加する", () => {
    const updated = updateSkillsRef(fixtureWithoutRef, "v0.6.1");
    expect(updated).toContain('"ref": "v0.6.1"');
    // 追加後も直前の comment やスキーマ行など、対象外の内容は保持される
    expect(updated).toContain("sample comment kept to verify jsonc comments survive the rewrite");
    expect(updated).toContain('"$schema": "https://example.invalid/schema.json"');
  });

  test("\"ref\" が既存なら値を上書きする (重複キーにならない)", () => {
    const updated = updateSkillsRef(fixtureWithRef, "v0.6.1");
    const refOccurrences = updated.match(/"ref":/g) ?? [];
    expect(refOccurrences).toHaveLength(1);
    expect(updated).toContain('"ref": "v0.6.1"');
    expect(updated).not.toContain('"ref": "v0.6.0"');
  });

  test("同じ tag を再適用すると出力は変化しない (冪等)", () => {
    const once = updateSkillsRef(fixtureWithoutRef, "v0.6.1");
    const twice = updateSkillsRef(once, "v0.6.1");
    expect(twice).toBe(once);
  });

  test("kanade0404/skills 以外の source (planetscale) は変更しない", () => {
    const updated = updateSkillsRef(fixtureWithoutRef, "v0.6.1");
    expect(updated).toContain(
      '"source": "https://github.com/planetscale/database-skills.git",\n      "transport": "git"\n    }',
    );
  });

  test("sourceUrl 引数で対象 source を切り替えられる", () => {
    const updated = updateSkillsRef(
      fixtureWithoutRef,
      "v1.0.0",
      "https://github.com/planetscale/database-skills.git",
    );
    expect(updated).toContain('"source": "https://github.com/planetscale/database-skills.git"');
    // planetscale ブロック側にだけ ref が入り、kanade0404/skills 側には入らない
    const skillsBlockStart = updated.indexOf("kanade0404/skills.git");
    const planetscaleBlockStart = updated.indexOf("planetscale/database-skills.git");
    const refIndex = updated.indexOf('"ref"');
    expect(refIndex).toBeGreaterThan(planetscaleBlockStart);
    expect(refIndex).toBeGreaterThan(skillsBlockStart);
  });

  test("\"sources\" 配列が無ければ throw する", () => {
    expect(() => updateSkillsRef("{}", "v0.6.1")).toThrow('"sources" array not found');
  });

  test("SKILLS_SOURCE_URL に一致する source が無ければ throw する", () => {
    const text = `{ "sources": [ { "source": "https://example.invalid/other.git", "transport": "git" } ] }`;
    expect(() => updateSkillsRef(text, "v0.6.1")).toThrow(`source ${SKILLS_SOURCE_URL} not found`);
  });
});

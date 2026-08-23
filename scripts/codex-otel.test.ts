import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve(".local/bin/codex-otel");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-otel-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runCodexOtel(target: string, env: Record<string, string> = {}) {
  return spawnSync(script, ["--write-config-only"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_OTEL_CONFIG_TARGET: target,
      OTEL_EXPORTER_TOKEN: "test-token",
      ...env,
    },
  });
}

function writeConfig(name: string, content: string): string {
  const path = join(root, name);
  writeFileSync(path, content);
  return path;
}

describe("codex-otel", () => {
  test.each([
    "[ otel ]\nenvironment = \"manual\"\n",
    "[ otel . metrics ]\nendpoint = \"manual\"\n",
    "[[otel]]\nenvironment = \"manual\"\n",
    "['otel']\nenvironment = \"manual\"\n",
    "[\"otel\"]\nenvironment = \"manual\"\n",
    "otel.environment = \"manual\"\n",
    "otel = { environment = \"manual\" }\n",
  ])("rejects unmanaged otel config variant %#", (content) => {
    const target = writeConfig("config.toml", content);
    const before = readFileSync(target, "utf8");

    const result = runCodexOtel(target);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unmanaged [otel] config already exists");
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  test("does not treat spaces inside quoted table keys as otel", () => {
    const target = writeConfig("config.toml", "[\"ot el\"]\nenvironment = \"manual\"\n");

    const result = runCodexOtel(target);

    expect(result.status).toBe(0);
    const generated = readFileSync(target, "utf8");
    expect(generated).toContain("[\"ot el\"]");
    expect(generated).toContain("# BEGIN CODEX OTEL MANAGED");
    expect(generated).toContain("[otel]");
  });

  test("does not replace config when managed block is unclosed", () => {
    const target = writeConfig("config.toml", "model = \"gpt-5\"\n# BEGIN CODEX OTEL MANAGED\n[otel]\n");
    const before = readFileSync(target, "utf8");

    const result = runCodexOtel(target);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing the end marker");
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  test("does not replace config when managed block has an orphan end marker", () => {
    const target = writeConfig("config.toml", "model = \"gpt-5\"\n# END CODEX OTEL MANAGED\nkeep = \"after\"\n");
    const before = readFileSync(target, "utf8");

    const result = runCodexOtel(target);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing the end marker");
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  test("does not replace config when managed block has a nested begin marker", () => {
    const target = writeConfig(
      "config.toml",
      "model = \"gpt-5\"\n# BEGIN CODEX OTEL MANAGED\n[otel]\n# BEGIN CODEX OTEL MANAGED\nkeep = \"skipped\"\n# END CODEX OTEL MANAGED\nkeep = \"after\"\n# END CODEX OTEL MANAGED\n",
    );
    const before = readFileSync(target, "utf8");

    const result = runCodexOtel(target);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing the end marker");
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  test("preserves unmanaged content and is idempotent", () => {
    const target = writeConfig("config.toml", "model = \"gpt-5\"\n\n[profiles.default]\nmodel = \"gpt-5-codex\"\n");

    const first = runCodexOtel(target);
    expect(first.status).toBe(0);
    const afterFirst = readFileSync(target, "utf8");

    const second = runCodexOtel(target);
    expect(second.status).toBe(0);
    const afterSecond = readFileSync(target, "utf8");

    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond).toContain("model = \"gpt-5\"");
    expect(afterSecond).toContain("[profiles.default]");
    expect(afterSecond.match(/# BEGIN CODEX OTEL MANAGED/g)).toHaveLength(1);
    expect(afterSecond.match(/# END CODEX OTEL MANAGED/g)).toHaveLength(1);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  test("falls back to defaults for env overrides with control characters", () => {
    const target = join(root, "config.toml");

    const result = runCodexOtel(target, {
      CODEX_OTEL_ENVIRONMENT: "bad\nvalue",
      CODEX_OTEL_LOGS_ENDPOINT: "https://logs.example.invalid\nbad",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("CODEX_OTEL_ENVIRONMENT contains control characters");
    expect(result.stderr).toContain("CODEX_OTEL_LOGS_ENDPOINT contains control characters");
    const generated = readFileSync(target, "utf8");
    expect(generated).toContain('environment = "dev"');
    expect(generated).toContain('endpoint = "https://otel-collector-vr35tgknva-an.a.run.app/v1/logs"');
  });
});

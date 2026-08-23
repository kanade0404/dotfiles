import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve(".local/bin/codex-otel");
const installScript = resolve("install.sh");

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
      CODEX_OTEL_ENVIRONMENT: "",
      CODEX_OTEL_LOGS_ENDPOINT: "",
      CODEX_OTEL_METRICS_ENDPOINT: "",
      CODEX_OTEL_TRACES_ENDPOINT: "",
      OTEL_EXPORTER_TOKEN: "test-token",
      ...env,
    },
  });
}

function pathWithMissingSecurity(): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const security = join(bin, "security");
  writeFileSync(security, "#!/usr/bin/env sh\nexit 1\n");
  chmodSync(security, 0o755);
  return `${bin}:${process.env.PATH ?? ""}`;
}

function pathWithStubCodex(): string {
  const bin = join(root, "codex-bin");
  mkdirSync(bin, { recursive: true });
  const codex = join(bin, "codex");
  writeFileSync(codex, "#!/usr/bin/env sh\nprintf 'stub codex:'\nprintf ' %s' \"$@\"\nprintf '\\n'\n");
  chmodSync(codex, 0o755);
  return `${bin}:${process.env.PATH ?? ""}`;
}

function writeConfig(name: string, content: string): string {
  const path = join(root, name);
  writeFileSync(path, content);
  return path;
}

function prepareDotfilesFixture(template = 'model = "template"\n'): string {
  const fixture = join(root, "dotfiles");
  mkdirSync(join(fixture, ".codex"), { recursive: true });
  mkdirSync(join(fixture, ".local", "bin"), { recursive: true });
  writeFileSync(join(fixture, ".codex", "config.toml"), template);
  symlinkSync(script, join(fixture, ".local", "bin", "codex-otel"));
  return fixture;
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

  test("does not treat otel table text inside multiline strings as unmanaged config", () => {
    const target = writeConfig("config.toml", 'instructions = """\n[otel]\n"""\n');

    const result = runCodexOtel(target);

    expect(result.status).toBe(0);
    const generated = readFileSync(target, "utf8");
    expect(generated).toContain('instructions = """\n[otel]\n"""');
    expect(generated).toContain("# BEGIN CODEX OTEL MANAGED");
  });

  test("does not treat triple quotes inside comments as multiline strings", () => {
    const target = writeConfig("config.toml", '# see """ in docs\n[otel]\nenvironment = "manual"\n');
    const before = readFileSync(target, "utf8");

    const result = runCodexOtel(target);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unmanaged [otel] config already exists");
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  test("writes bearer token headers for all exporters", () => {
    const target = join(root, "config.toml");

    const result = runCodexOtel(target);

    expect(result.status).toBe(0);
    const generated = readFileSync(target, "utf8");
    expect(generated).toContain('[otel.exporter."otlp-http".headers]');
    expect(generated).toContain('[otel.metrics_exporter."otlp-http".headers]');
    expect(generated).toContain('[otel.trace_exporter."otlp-http".headers]');
    expect(generated.match(/Authorization = "Bearer test-token"/g)).toHaveLength(3);
  });

  test("omits headers when no token is available", () => {
    const target = join(root, "config.toml");

    const result = runCodexOtel(target, {
      OTEL_EXPORTER_TOKEN: "",
      PATH: pathWithMissingSecurity(),
    });

    expect(result.status).toBe(0);
    const generated = readFileSync(target, "utf8");
    expect(generated).not.toContain(".headers]");
    expect(generated).not.toContain("Authorization");
  });

  test("replaces old bearer tokens when token changes", () => {
    const target = join(root, "config.toml");

    const first = runCodexOtel(target, { OTEL_EXPORTER_TOKEN: "old-token" });
    expect(first.status).toBe(0);
    const second = runCodexOtel(target, { OTEL_EXPORTER_TOKEN: "new-token" });
    expect(second.status).toBe(0);

    const generated = readFileSync(target, "utf8");
    expect(generated).not.toContain("old-token");
    expect(generated.match(/Authorization = "Bearer new-token"/g)).toHaveLength(3);
  });

  test("preserves existing Authorization when token lookup fails", () => {
    const target = writeConfig(
      "config.toml",
      'model = "gpt-5"\n# BEGIN CODEX OTEL MANAGED\n[otel]\nenvironment = "dev"\n\n[otel.exporter."otlp-http".headers]\nAuthorization = "Bearer existing-token"\n# END CODEX OTEL MANAGED\n',
    );
    const before = readFileSync(target, "utf8");

    const result = runCodexOtel(target, {
      OTEL_EXPORTER_TOKEN: "",
      PATH: pathWithMissingSecurity(),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("preserving existing Authorization header");
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  test("install preserves existing Authorization when token lookup fails", () => {
    const dotfiles = prepareDotfilesFixture();
    const home = join(root, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      'model = "old"\n# BEGIN CODEX OTEL MANAGED\n[otel]\nenvironment = "dev"\n\n[otel.exporter."otlp-http".headers]\nAuthorization = "Bearer existing-token"\n\n[otel.metrics_exporter."otlp-http".headers]\nAuthorization = "Bearer existing-token"\n\n[otel.trace_exporter."otlp-http".headers]\nAuthorization = "Bearer existing-token"\n# END CODEX OTEL MANAGED\n',
    );

    const result = spawnSync("bash", [installScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        DOTFILES: dotfiles,
        HOME: home,
        OTEL_EXPORTER_TOKEN: "",
        PATH: pathWithMissingSecurity(),
      },
    });

    expect(result.status).toBe(0);
    const generated = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(generated).toContain('model = "template"');
    expect(generated).not.toContain('model = "old"');
    expect(generated.match(/Authorization = "Bearer existing-token"/g)).toHaveLength(3);
  });

  test("preserves escaped Authorization from a backup without double escaping", () => {
    const target = writeConfig("target.toml", 'model = "template"\n');
    const backup = writeConfig(
      "backup.toml",
      'model = "old"\n# BEGIN CODEX OTEL MANAGED\n[otel]\nenvironment = "dev"\n\n[otel.exporter."otlp-http".headers]\nAuthorization = "Bearer abc\\\\def\\"ghi"\n# END CODEX OTEL MANAGED\n',
    );

    const result = runCodexOtel(target, {
      OTEL_EXPORTER_TOKEN: "",
      CODEX_OTEL_PRESERVE_AUTH_FROM: backup,
      PATH: pathWithMissingSecurity(),
    });

    expect(result.status).toBe(0);
    const generated = readFileSync(target, "utf8");
    expect(generated.match(/Authorization = "Bearer abc\\\\def\\"ghi"/g)).toHaveLength(3);
    expect(generated).not.toContain("abc\\\\\\\\def");
  });

  test("does not preserve Authorization from an unbalanced preserve source", () => {
    const target = writeConfig("target.toml", 'model = "template"\n');
    const before = readFileSync(target, "utf8");
    const backup = writeConfig(
      "backup.toml",
      'model = "old"\n# BEGIN CODEX OTEL MANAGED\n[otel.exporter."otlp-http".headers]\nAuthorization = "Bearer existing-token"\n',
    );

    const result = runCodexOtel(target, {
      OTEL_EXPORTER_TOKEN: "",
      CODEX_OTEL_PRESERVE_AUTH_FROM: backup,
      PATH: pathWithMissingSecurity(),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to preserve Authorization");
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  test("install continues and retains backup when OTEL refresh fails", () => {
    const dotfiles = prepareDotfilesFixture();
    const home = join(root, "home-retain");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const oldConfig =
      'model = "old"\n# BEGIN CODEX OTEL MANAGED\n[otel.exporter."otlp-http".headers]\nAuthorization = "Bearer existing-token"\n';
    writeFileSync(join(home, ".codex", "config.toml"), oldConfig);

    const result = spawnSync("bash", [installScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        DOTFILES: dotfiles,
        HOME: home,
        OTEL_EXPORTER_TOKEN: "",
        PATH: pathWithMissingSecurity(),
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("failed to refresh Codex OTEL config; continuing install.sh");
    expect(result.stderr).toContain("retained previous Codex config backup");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain('model = "template"');
    const backups = readdirSync(join(home, ".codex")).filter((name) => name.startsWith("config.toml.bak."));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home, ".codex", backups[0]), "utf8")).toBe(oldConfig);
  });

  test("does not preserve Authorization from an unbalanced managed block", () => {
    const target = writeConfig(
      "config.toml",
      'model = "gpt-5"\n# BEGIN CODEX OTEL MANAGED\n[otel.exporter."otlp-http".headers]\nAuthorization = "Bearer existing-token"\n',
    );
    const before = readFileSync(target, "utf8");

    const result = runCodexOtel(target, {
      OTEL_EXPORTER_TOKEN: "",
      PATH: pathWithMissingSecurity(),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("markers in");
    expect(result.stderr).toContain("are unbalanced");
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  test("does not replace config when managed block is unclosed", () => {
    const target = writeConfig("config.toml", "model = \"gpt-5\"\n# BEGIN CODEX OTEL MANAGED\n[otel]\n");
    const before = readFileSync(target, "utf8");

    const result = runCodexOtel(target);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("markers in");
    expect(result.stderr).toContain("are unbalanced");
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  test("does not replace config when managed block has an orphan end marker", () => {
    const target = writeConfig("config.toml", "model = \"gpt-5\"\n# END CODEX OTEL MANAGED\nkeep = \"after\"\n");
    const before = readFileSync(target, "utf8");

    const result = runCodexOtel(target);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("markers in");
    expect(result.stderr).toContain("are unbalanced");
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
    expect(result.stderr).toContain("markers in");
    expect(result.stderr).toContain("are unbalanced");
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

  test("launch mode continues to codex when config refresh fails", () => {
    const target = writeConfig("config.toml", 'model = "gpt-5"\n# BEGIN CODEX OTEL MANAGED\n[otel]\n');
    const before = readFileSync(target, "utf8");

    const result = spawnSync(script, ["debug", "prompt-input", "hello"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_OTEL_CONFIG_TARGET: target,
        OTEL_EXPORTER_TOKEN: "test-token",
        PATH: pathWithStubCodex(),
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("failed to refresh OTEL config; launching codex without refreshing telemetry");
    expect(result.stdout).toContain("stub codex: debug prompt-input hello");
    expect(readFileSync(target, "utf8")).toBe(before);
  });
});

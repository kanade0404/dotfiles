import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
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

// install.sh copies these unconditionally; they must exist in the fixture or install.sh aborts.
// If install.sh gains more unconditionally-installed files, update this map too.
const MANAGED_FIXTURE_FILES = {
  ".codex/config.toml": 'model = "template"\n',
  ".codex/hooks.json": '{\n  "hooks": {}\n}\n',
  ".claude/settings.json": '{\n  "hooks": {}\n}\n',
} as const;

type ManagedFixtureFile = keyof typeof MANAGED_FIXTURE_FILES;

// install.sh が各ファイルへ与える permission。config.toml は OTEL bearer token を
// 平文で保持するため 600 でなければならない。
const MANAGED_FILE_MODES: Record<ManagedFixtureFile, number> = {
  ".codex/config.toml": 0o600,
  ".codex/hooks.json": 0o644,
  ".claude/settings.json": 0o644,
};

function prepareDotfilesFixture(
  template = MANAGED_FIXTURE_FILES[".codex/config.toml"],
  omit: readonly ManagedFixtureFile[] = [],
): string {
  const fixture = join(root, "dotfiles");
  mkdirSync(join(fixture, ".codex"), { recursive: true });
  mkdirSync(join(fixture, ".claude"), { recursive: true });
  mkdirSync(join(fixture, ".local", "bin"), { recursive: true });
  const contents: Record<ManagedFixtureFile, string> = {
    ...MANAGED_FIXTURE_FILES,
    ".codex/config.toml": template,
  };
  for (const relative of Object.keys(contents) as ManagedFixtureFile[]) {
    if (omit.includes(relative)) continue;
    writeFileSync(join(fixture, ...relative.split("/")), contents[relative]);
  }
  symlinkSync(script, join(fixture, ".local", "bin", "codex-otel"));
  return fixture;
}

function runInstall(dotfiles: string, home: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [installScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      DOTFILES: dotfiles,
      HOME: home,
      OTEL_EXPORTER_TOKEN: "test-token",
      ...env,
    },
  });
}

function leftoverTempFiles(dir: string, basename: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(`${basename}.tmp`));
}

// install_managed_file() だけを install.sh から切り出し、errexit を抑止した呼び出し文脈
// (`f || status=$?`) で単体実行する harness。関数が返した status と dest の状態を
// 呼び出し側の errexit に頼らず観測できる。
function runInstallManagedFile(
  harnessName: string,
  src: string,
  dest: string,
): { status: number; stderr: string } {
  const harness = join(root, `${harnessName}.sh`);
  writeFileSync(
    harness,
    [
      "set -euo pipefail",
      extractShellFunction("install_managed_file"),
      extractShellFunction("cleanup_managed_file_temps"),
      "managed_file_temps=()",
      "status=0",
      'install_managed_file 644 "$1" "$2" || status=$?',
      'printf "status=%s\\n" "$status"',
      "cleanup_managed_file_temps",
      "",
    ].join("\n"),
  );

  const result = spawnSync("bash", [harness, src, dest], { encoding: "utf8" });
  const reported = /^status=(\d+)$/m.exec(result.stdout ?? "");
  if (reported === null) {
    throw new Error(`harness did not report a status. stderr: ${result.stderr ?? ""}`);
  }
  return { status: Number(reported[1]), stderr: result.stderr ?? "" };
}

// install.sh の関数定義だけを抜き出して単体で実行するためのヘルパー。
// install.sh は source すると全処理が走ってしまうため、定義を切り出して harness に埋める。
function extractShellFunction(name: string): string {
  const lines = readFileSync(installScript, "utf8").split("\n");
  const start = lines.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`install.sh: ${name}() not found`);
  const end = lines.indexOf("}", start);
  if (end === -1) throw new Error(`install.sh: ${name}() has no closing brace`);
  return lines.slice(start, end + 1).join("\n");
}

// ~/.claude/settings.json と ~/.codex/hooks.json は Orca が pane 起動毎に書き換えるため、
// symlink で配布すると git 管理下の実体が汚染される。実体コピーであることを固定する。
function expectInstalledMode(home: string, relative: ManagedFixtureFile) {
  const installed = join(home, ...relative.split("/"));

  expect(statSync(installed).mode & 0o777).toBe(MANAGED_FILE_MODES[relative]);
}

function expectInstalledAsRealFile(home: string, dotfiles: string, relative: ManagedFixtureFile) {
  const parts = relative.split("/");
  const installed = join(home, ...parts);

  expect(lstatSync(installed).isSymbolicLink()).toBe(false);
  expect(readFileSync(installed, "utf8")).toBe(readFileSync(join(dotfiles, ...parts), "utf8"));
  expectInstalledMode(home, relative);
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

    const result = runInstall(dotfiles, home, {
      OTEL_EXPORTER_TOKEN: "",
      PATH: pathWithMissingSecurity(),
    });

    expect(result.status).toBe(0);
    const generated = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(generated).toContain('model = "template"');
    expect(generated).not.toContain('model = "old"');
    expect(generated.match(/Authorization = "Bearer existing-token"/g)).toHaveLength(3);
    expect(lstatSync(join(home, ".codex", "config.toml")).isSymbolicLink()).toBe(false);
    expectInstalledMode(home, ".codex/config.toml");
    expectInstalledAsRealFile(home, dotfiles, ".claude/settings.json");
    expectInstalledAsRealFile(home, dotfiles, ".codex/hooks.json");
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

    const result = runInstall(dotfiles, home, {
      OTEL_EXPORTER_TOKEN: "",
      PATH: pathWithMissingSecurity(),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("failed to refresh Codex OTEL config; continuing install.sh");
    expect(result.stderr).toContain("retained previous Codex config backup");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain('model = "template"');
    const backups = readdirSync(join(home, ".codex")).filter((name) => name.startsWith("config.toml.bak."));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home, ".codex", backups[0]), "utf8")).toBe(oldConfig);
    expect(lstatSync(join(home, ".codex", "config.toml")).isSymbolicLink()).toBe(false);
    expectInstalledMode(home, ".codex/config.toml");
    expectInstalledAsRealFile(home, dotfiles, ".claude/settings.json");
    expectInstalledAsRealFile(home, dotfiles, ".codex/hooks.json");
  });

  // 本 PR の移行対象そのもの: 既存マシンの dest は dotfiles repo への symlink になっている。
  // install.sh 再実行で (a) dest が実体に変わり (b) repo 側の source が書き換わらないこと。
  // (b) が壊れると Orca の書き込みが git 管理下へ漏れる = 移行の目的が失われる。
  test.each([
    [".claude/settings.json", ".claude", "settings.json"],
    [".codex/hooks.json", ".codex", "hooks.json"],
  ] as const)("install replaces an existing dotfiles symlink at %s with a real file", (relative, dir, basename) => {
    const dotfiles = prepareDotfilesFixture();
    const home = join(root, `home-symlink-${basename}`);
    mkdirSync(join(home, dir), { recursive: true });
    const source = join(dotfiles, dir, basename);
    const sourceBefore = readFileSync(source, "utf8");
    const dest = join(home, dir, basename);
    symlinkSync(source, dest);

    const result = runInstall(dotfiles, home);

    expect(result.status).toBe(0);
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, "utf8")).toBe(sourceBefore);
    expectInstalledMode(home, relative);

    // dest への書き込みが repo 側へ届かないこと (= symlink が本当に切れていること)。
    writeFileSync(dest, '{\n  "hooks": {},\n  "localOnly": true\n}\n');
    expect(readFileSync(source, "utf8")).toBe(sourceBefore);
  });

  // config.toml は install 直後に codex-otel が bearer token を書き込むため、
  // symlink が残っていると token が repo の template へ漏れる。
  test("install replaces an existing dotfiles symlink at .codex/config.toml with a real file", () => {
    const dotfiles = prepareDotfilesFixture();
    const home = join(root, "home-symlink-config");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const source = join(dotfiles, ".codex", "config.toml");
    const sourceBefore = readFileSync(source, "utf8");
    const dest = join(home, ".codex", "config.toml");
    symlinkSync(source, dest);

    const result = runInstall(dotfiles, home);

    expect(result.status).toBe(0);
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, "utf8")).toContain("Bearer test-token");
    expectInstalledMode(home, ".codex/config.toml");
    expect(readFileSync(source, "utf8")).toBe(sourceBefore);
    expect(readFileSync(source, "utf8")).not.toContain("test-token");
  });

  test.each([
    [".claude/settings.json", ".claude", "settings.json"],
    [".codex/hooks.json", ".codex", "hooks.json"],
    [".codex/config.toml", ".codex", "config.toml"],
  ] as const)("install keeps the existing %s when the dotfiles source is missing", (relative, dir, basename) => {
    const dotfiles = prepareDotfilesFixture(undefined, [relative]);
    const home = join(root, `home-missing-${basename}`);
    mkdirSync(join(home, dir), { recursive: true });
    const existing = `# pre-existing ${relative}\n`;
    writeFileSync(join(home, dir, basename), existing);

    const result = runInstall(dotfiles, home);

    expect(result.status).not.toBe(0);
    expect(existsSync(join(home, dir, basename))).toBe(true);
    expect(readFileSync(join(home, dir, basename), "utf8")).toBe(existing);
    expect(leftoverTempFiles(join(home, dir), basename)).toHaveLength(0);
  });

  // install_managed_file の安全性は呼び出し側の ambient errexit に依存してはならない。
  // `f || warn` / `if ! f` のような errexit 抑止文脈で source 不在のまま呼ばれても、
  // mktemp の空ファイルを dest に被せて 0 を返すことがあってはならない。
  test("install_managed_file fails without blanking dest when errexit is suppressed", () => {
    const dir = join(root, "errexit-suppressed");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, "settings.json");
    const existing = '{\n  "hooks": {}\n}\n';
    writeFileSync(dest, existing);

    const { status } = runInstallManagedFile(
      "errexit-suppressed-harness",
      join(dir, "missing-source.json"),
      dest,
    );

    expect(status).not.toBe(0);
    expect(readFileSync(dest, "utf8")).toBe(existing);
    expect(leftoverTempFiles(dir, "settings.json")).toHaveLength(0);
  });

  // dest が directory だと `mv -f tmp dest` は「置き換え」ではなく「dest の中へ移動」に
  // なって 0 を返す。置き換わっていないのに成功する経路を関数内で塞ぐ。
  test("install_managed_file refuses a directory dest instead of succeeding silently", () => {
    const dir = join(root, "directory-dest");
    mkdirSync(dir, { recursive: true });
    const src = join(dir, "source.json");
    writeFileSync(src, '{\n  "hooks": {}\n}\n');
    const dest = join(dir, "settings.json");
    mkdirSync(dest);

    const { status } = runInstallManagedFile("directory-dest-harness", src, dest);

    expect(status).not.toBe(0);
    expect(statSync(dest).isDirectory()).toBe(true);
    expect(readdirSync(dest)).toHaveLength(0);
    expect(leftoverTempFiles(dir, "settings.json")).toHaveLength(0);
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

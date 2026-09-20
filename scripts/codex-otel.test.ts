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
      // runCodexOtel と同様、開発マシンが export している CODEX_OTEL_* で
      // 生成内容が変わらないよう中和する。
      CODEX_OTEL_ENVIRONMENT: "",
      CODEX_OTEL_LOGS_ENDPOINT: "",
      CODEX_OTEL_METRICS_ENDPOINT: "",
      CODEX_OTEL_TRACES_ENDPOINT: "",
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
  backup = "",
): { status: number; stderr: string } {
  const harness = join(root, `${harnessName}.sh`);
  writeFileSync(
    harness,
    [
      "set -euo pipefail",
      extractShellFunction("install_managed_file"),
      extractShellFunction("backup_local_settings"),
      extractShellFunction("cleanup_managed_file_temps"),
      "managed_file_temps=()",
      "status=0",
      'install_managed_file 644 "$1" "$2" "$3" || status=$?',
      'printf "status=%s\\n" "$status"',
      "cleanup_managed_file_temps",
      "",
    ].join("\n"),
  );

  const result = spawnSync("bash", [harness, src, dest, backup], { encoding: "utf8" });
  const reported = /^status=(\d+)$/m.exec(result.stdout ?? "");
  if (reported === null) {
    throw new Error(`harness did not report a status. stderr: ${result.stderr ?? ""}`);
  }
  return { status: Number(reported[1]), stderr: result.stderr ?? "" };
}

// install.sh の関数定義だけを抜き出して単体で実行するためのヘルパー。
// install.sh は source すると全処理が走ってしまうため、定義を切り出して harness に埋める。
// 起点は `lines.indexOf("<name>() {")` = **行全体の完全一致**なので、`# <name>() {` の
// ようなコメント行や字下げされた行は拾わない (正規表現 `^<name>\(\) \{$` と同義)。
// 閉じ括弧の判定は「行全体が }」のヒューリスティックなので、本体に column-0 の }
// (入れ子関数や heredoc 等) が入ると途中で切れる。切れた断片が偶然 parse できると
// 「別物をテストしたまま pass」するため、抽出結果が関数定義として成立するか検証する。
// 残余リスク: install.sh が heredoc の中に同一の定義行を持つ、かつ途中切断しても
// 構文的に整合する、という両方が同時に成立する場合。install.sh に heredoc は無く、
// 対象関数も 1 つずつしか定義されていないため受容する。
function extractShellFunction(name: string, source = readFileSync(installScript, "utf8")): string {
  const lines = source.split("\n");
  const start = lines.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`install.sh: ${name}() not found`);
  const end = lines.indexOf("}", start);
  if (end === -1) throw new Error(`install.sh: ${name}() has no closing brace`);
  const snippet = lines.slice(start, end + 1).join("\n");

  const check = spawnSync("bash", ["-c", `${snippet}\ndeclare -F ${name} >/dev/null`], {
    encoding: "utf8",
  });
  if (check.status !== 0) {
    throw new Error(`extracted ${name}() is not a valid function definition`);
  }
  return snippet;
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

  // install.sh 再実行は dest を dotfiles の内容へ巻き戻すため、ローカルに溜まった設定
  // (`/permissions` で追加した deny 等) が失われる。取り戻せるよう 1 世代だけ退避する。
  test.each([
    [".claude/settings.json", ".claude", "settings.json"],
    [".codex/hooks.json", ".codex", "hooks.json"],
  ] as const)("install backs up the previous %s before overwriting it", (relative, dir, basename) => {
    const dotfiles = prepareDotfilesFixture();
    const home = join(root, `home-backup-${basename}`);
    mkdirSync(join(home, dir), { recursive: true });
    const dest = join(home, dir, basename);
    const local = '{\n  "permissions": {\n    "deny": ["Bash(rm -rf /)"]\n  }\n}\n';
    writeFileSync(dest, local);

    const result = runInstall(dotfiles, home);

    expect(result.status).toBe(0);
    expect(readFileSync(`${dest}.bak`, "utf8")).toBe(local);
    expect(readFileSync(dest, "utf8")).toBe(readFileSync(join(dotfiles, ...relative.split("/")), "utf8"));
    // 退避も temp 経由で差し替えるので、temp が残っていないこと。
    expect(leftoverTempFiles(join(home, dir), `${basename}.bak`)).toHaveLength(0);
  });

  // 既存の `.bak` は `cp` の O_TRUNC でいきなり失われるため、直接書くと cp の途中失敗で
  // 唯一の復旧コピーが壊れた断片に化ける。temp 経由の差し替えであることを固定する。
  // 判別オラクルは inode: in-place な `cp` は既存 `.bak` を truncate して同じ inode に
  // 書き込むが、temp + `mv` (rename(2)) なら inode が入れ替わる。
  test("install replaces .bak through a temp file instead of truncating it in place", () => {
    const dotfiles = prepareDotfilesFixture();
    const home = join(root, "home-bak-atomic");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const dest = join(home, ".claude", "settings.json");
    const local = '{\n  "local": true\n}\n';
    writeFileSync(dest, local);
    const bak = `${dest}.bak`;
    writeFileSync(bak, "# previous recovery copy\n");
    const inodeBefore = statSync(bak).ino;

    const result = runInstall(dotfiles, home);

    expect(result.status).toBe(0);
    expect(readFileSync(bak, "utf8")).toBe(local);
    expect(statSync(bak).ino).not.toBe(inodeBefore);
    expect(leftoverTempFiles(join(home, ".claude"), "settings.json.bak")).toHaveLength(0);
  });

  // 退避が取れないまま上書きすると、保険が最も必要な瞬間にローカル設定の唯一のコピーが
  // 不可逆に失われる。dest を読めなくすると `cp -p` が決定的に失敗するので、
  // 「退避失敗なら置き換えを中止し dest は無傷」を固定できる。
  // (ENOSPC 等「書き込み途中で失敗」の再現は決定的にできないため未カバー。)
  // root は permission bit を無視するので skip する (silent return にすると
  // root で走る CI でこの契約が一度も検証されないまま green になる)。
  test.skipIf(process.getuid?.() === 0)("install aborts without overwriting dest when the backup copy fails", () => {
    const dotfiles = prepareDotfilesFixture();
    const home = join(root, "home-bak-unreadable");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const dest = join(home, ".claude", "settings.json");
    const local = '{\n  "local": true\n}\n';
    writeFileSync(dest, local);
    chmodSync(dest, 0o000);

    const result = runInstall(dotfiles, home);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to overwrite");
    expect(existsSync(`${dest}.bak`)).toBe(false);
    expect(leftoverTempFiles(join(home, ".claude"), "settings.json.bak")).toHaveLength(0);
    chmodSync(dest, 0o644);
    expect(readFileSync(dest, "utf8")).toBe(local);
  });

  // 引数の検証は mktemp / install の副作用より前に済ませる。
  test("install_managed_file rejects an unknown backup flag before creating a temp", () => {
    const dir = join(root, "unknown-flag-no-temp");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, "settings.json");
    const existing = '{\n  "local": true\n}\n';
    writeFileSync(dest, existing);

    const { status, stderr } = runInstallManagedFile(
      "unknown-flag-no-temp-harness",
      join(dir, "missing-source.json"),
      dest,
      "bakcup",
    );

    // source が存在しないので、検証が staging より後ろにあると install の失敗で
    // 先に return し、このメッセージは出ない = 順序の判別オラクルになる。
    expect(status).not.toBe(0);
    expect(stderr).toContain("unknown backup flag");
    expect(readFileSync(dest, "utf8")).toBe(existing);
    expect(leftoverTempFiles(dir, "settings.json")).toHaveLength(0);
  });

  // mktemp は dest と同じディレクトリに作るため、親が書き込み不可なら staging 以前に失敗する。
  test.skipIf(process.getuid?.() === 0)(
    "install_managed_file fails without touching dest when the temp cannot be created",
    () => {
    const dir = join(root, "readonly-dest-dir");
    mkdirSync(dir, { recursive: true });
    const src = join(root, "readonly-source.json");
    writeFileSync(src, '{\n  "hooks": {}\n}\n');
    const dest = join(dir, "settings.json");
    const existing = '{\n  "local": true\n}\n';
    writeFileSync(dest, existing);
    chmodSync(dir, 0o555);

    let outcome;
    try {
      outcome = runInstallManagedFile("readonly-dest-harness", src, dest);
    } finally {
      chmodSync(dir, 0o755);
    }

      expect(outcome.status).not.toBe(0);
      expect(readFileSync(dest, "utf8")).toBe(existing);
      expect(leftoverTempFiles(dir, "settings.json")).toHaveLength(0);
    },
  );

  // EXIT trap は untrapped fatal signal では走らないので、signal 側にも trap を張って
  // temp を掃除し `exit 128+signum` で抜ける。`kill -s TERM $$` は同期発火なので
  // flaky にならない。
  // install.sh 本体の trap 登録行 (`trap 'cleanup_install_and_exit 15' TERM`) を通す。
  // fixture の codex-otel を「親 (install.sh) へ SIGTERM を送る」stub に差し替えると、
  // install.sh が動いている最中に決定的に signal を配送できる。
  // trap が無ければ bash は signal で殺され、spawnSync の status は null になる。
  test("install.sh registers a TERM trap and exits 128+signum", () => {
    const dotfiles = prepareDotfilesFixture();
    const stub = join(dotfiles, ".local", "bin", "codex-otel");
    rmSync(stub, { force: true });
    writeFileSync(stub, '#!/usr/bin/env sh\nkill -TERM "$PPID"\nexit 0\n');
    chmodSync(stub, 0o755);
    const home = join(root, "home-signal-install");
    mkdirSync(join(home, ".codex"), { recursive: true });

    const result = runInstall(dotfiles, home);

    expect(result.status).toBe(143);
    expect(leftoverTempFiles(join(home, ".codex"), "config.toml")).toHaveLength(0);
  });

  // 上のテストが通す経路と違い、こちらは cleanup 関数群そのものの振る舞いを見る
  // (trap 登録は harness 側で行うため、install.sh の trap 行はカバーしない)。
  test("cleanup_install_and_exit removes temps and exits 128+signum when a TERM trap fires", () => {
    const dir = join(root, "signal-trap");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, "settings.json");
    const harness = join(root, "signal-trap-harness.sh");
    writeFileSync(
      harness,
      [
        "set -euo pipefail",
        extractShellFunction("cleanup_codex_config_backup"),
        extractShellFunction("cleanup_managed_file_temps"),
        extractShellFunction("cleanup_install"),
        extractShellFunction("cleanup_install_and_exit"),
        'codex_config_backup=""',
        "managed_file_temps=()",
        "trap cleanup_install EXIT",
        "trap 'cleanup_install_and_exit 15' TERM",
        'tmp="$(mktemp "$1.tmp.XXXXXX")"',
        'managed_file_temps+=("$tmp")',
        "kill -s TERM $$",
        "sleep 5",
        "",
      ].join("\n"),
    );

    const result = spawnSync("bash", [harness, dest], { encoding: "utf8" });

    expect(result.status).toBe(143);
    expect(leftoverTempFiles(dir, "settings.json")).toHaveLength(0);
  });

  // 退避は source の staging に成功した後にだけ行う。source 不在で install が失敗する
  // ケースで既存の `.bak` を潰すと、巻き戻りからの復旧手段そのものが消える。
  test("install keeps an existing .bak when the dotfiles source is missing", () => {
    const dotfiles = prepareDotfilesFixture(undefined, [".claude/settings.json"]);
    const home = join(root, "home-bak-preserved");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const dest = join(home, ".claude", "settings.json");
    const recovery = '{\n  "permissions": {\n    "deny": ["Bash(rm -rf /)"]\n  }\n}\n';
    const current = '{\n  "hooks": {}\n}\n';
    writeFileSync(`${dest}.bak`, recovery);
    writeFileSync(dest, current);

    const result = runInstall(dotfiles, home);

    expect(result.status).not.toBe(0);
    expect(readFileSync(`${dest}.bak`, "utf8")).toBe(recovery);
    expect(readFileSync(dest, "utf8")).toBe(current);
  });

  // ローカル差分が無いのに退避すると、意味のある退避を dotfiles と同一の内容で潰す。
  test("install does not overwrite .bak when dest already matches the dotfiles source", () => {
    const dotfiles = prepareDotfilesFixture();
    const home = join(root, "home-bak-nodiff");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const dest = join(home, ".claude", "settings.json");
    const local = '{\n  "permissions": {\n    "deny": ["Bash(rm -rf /)"]\n  }\n}\n';
    writeFileSync(dest, local);

    expect(runInstall(dotfiles, home).status).toBe(0);
    expect(readFileSync(`${dest}.bak`, "utf8")).toBe(local);

    // 2 回目は dest が dotfiles と同一なので退避をスキップし、1 回目の退避を残す。
    expect(runInstall(dotfiles, home).status).toBe(0);
    expect(readFileSync(`${dest}.bak`, "utf8")).toBe(local);
  });

  // `.bak` が directory / symlink だと `cp -p` は「中へコピー」「リンク先へ書き込み」に
  // なり、「<dest>.bak から手で戻せる」という契約が黙って破れる。退避が取れない以上
  // dest は上書きせず中止する。
  // ガードは `[ -L ]` と「存在するが `-f` でない」の 2 条件なので、directory だけでなく
  // symlink (通常 / dangling) も固定する。
  test.each(["directory", "symlink-to-file", "dangling-symlink"] as const)(
    "install aborts without overwriting dest when .bak is a %s",
    (kind) => {
      const dotfiles = prepareDotfilesFixture();
      const home = join(root, `home-bak-${kind}`);
      mkdirSync(join(home, ".claude"), { recursive: true });
      const dest = join(home, ".claude", "settings.json");
      const local = '{\n  "local": true\n}\n';
      writeFileSync(dest, local);
      const bak = `${dest}.bak`;
      const linkTarget = join(home, ".claude", "bak-target.json");
      const targetBefore = "# untouched\n";
      if (kind === "directory") {
        mkdirSync(bak);
      } else if (kind === "symlink-to-file") {
        writeFileSync(linkTarget, targetBefore);
        symlinkSync(linkTarget, bak);
      } else {
        symlinkSync(join(home, ".claude", "missing-target.json"), bak);
      }

      const result = runInstall(dotfiles, home);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("refusing to overwrite");
      expect(readFileSync(dest, "utf8")).toBe(local);
      if (kind === "directory") {
        expect(statSync(bak).isDirectory()).toBe(true);
        expect(readdirSync(bak)).toHaveLength(0);
      } else {
        // symlink はリンク先へ書き込まれず、リンクのまま残る。
        expect(lstatSync(bak).isSymbolicLink()).toBe(true);
      }
      if (kind === "symlink-to-file") {
        expect(readFileSync(linkTarget, "utf8")).toBe(targetBefore);
      }
      if (kind === "dangling-symlink") {
        expect(existsSync(bak)).toBe(false);
      }
    },
  );

  // 第 4 引数は stringly-typed なので、typo (`bakcup` 等) が黙って「退避なし」に
  // 落ちないよう、未知の値は明示的に失敗させる。
  test("install_managed_file rejects an unknown backup flag", () => {
    const dir = join(root, "unknown-backup-flag");
    mkdirSync(dir, { recursive: true });
    const src = join(dir, "source.json");
    writeFileSync(src, '{\n  "hooks": {}\n}\n');
    const dest = join(dir, "settings.json");
    const existing = '{\n  "local": true\n}\n';
    writeFileSync(dest, existing);

    const { status, stderr } = runInstallManagedFile(
      "unknown-backup-flag-harness",
      src,
      dest,
      "bakcup",
    );

    expect(status).not.toBe(0);
    expect(stderr).toContain("unknown backup flag");
    expect(readFileSync(dest, "utf8")).toBe(existing);
    expect(existsSync(`${dest}.bak`)).toBe(false);
    expect(leftoverTempFiles(dir, "settings.json")).toHaveLength(0);
  });

  // config.toml は bearer token を平文で持つため、退避コピーを増やさない。
  test("install does not copy .codex/config.toml to a .bak slot", () => {
    const dotfiles = prepareDotfilesFixture();
    const home = join(root, "home-backup-config");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "local"\n');

    const result = runInstall(dotfiles, home);

    expect(result.status).toBe(0);
    expect(existsSync(join(home, ".codex", "config.toml.bak"))).toBe(false);
  });

  // dest が directory だと `mv -f tmp dest` は「置き換え」ではなく「dest の中へ移動」に
  // なって 0 を返す。置き換わっていないのに成功する経路を関数内で塞ぐ。
  // ガードが `[ -d ]` (symlink を辿る) であることに依存しているので、実 directory と
  // directory への symlink の両方を固定する。
  test.each(["directory", "symlink-to-directory"] as const)(
    "install_managed_file refuses a %s dest instead of succeeding silently",
    (kind) => {
    const dir = join(root, `directory-dest-${kind}`);
    mkdirSync(dir, { recursive: true });
    const src = join(dir, "source.json");
    writeFileSync(src, '{\n  "hooks": {}\n}\n');
    const dest = join(dir, "settings.json");
    if (kind === "directory") {
      mkdirSync(dest);
    } else {
      const real = join(dir, "real-directory");
      mkdirSync(real);
      symlinkSync(real, dest);
    }

    const { status } = runInstallManagedFile(`directory-dest-harness-${kind}`, src, dest);

    expect(status).not.toBe(0);
    expect(statSync(dest).isDirectory()).toBe(true);
    expect(readdirSync(dest)).toHaveLength(0);
    expect(leftoverTempFiles(dir, "settings.json")).toHaveLength(0);
    },
  );

  // extractShellFunction は「行全体が }」を閉じ括弧とみなすヒューリスティックなので、
  // 対象関数の本体に column-0 の } が入ると途中で切れる。切れた断片が偶然 parse できると
  // 「別物をテストしたまま pass」するため、抽出結果が関数定義として成立するかを検証する。
  test("extractShellFunction rejects a truncated extraction", () => {
    const truncating = [
      "sample_fn() {",
      "  nested() {",
      "    :",
      "}",
      "  echo tail",
      "}",
      "",
    ].join("\n");

    expect(() => extractShellFunction("sample_fn", truncating)).toThrow(
      /not a valid function definition/,
    );
  });

  test("extractShellFunction returns the whole body of a well-formed function", () => {
    const wellFormed = ["sample_fn() {", "  nested() {", "    :", "  }", "  echo tail", "}", ""].join(
      "\n",
    );

    expect(extractShellFunction("sample_fn", wellFormed)).toBe(
      ["sample_fn() {", "  nested() {", "    :", "  }", "  echo tail", "}"].join("\n"),
    );
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

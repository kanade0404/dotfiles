import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { localSettingsRootsOf } from "./git-repository.ts";
import { extractBashPattern, patternToRegex } from "./rule-matcher.ts";
import type { Rule, RuleCategory } from "./types.ts";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * 単一の settings.json から Bash ルールを読み込む。
 * ファイルが存在しない場合は空配列を返す。
 */
function loadRulesFromFile(path: string, readByClaudeCode: boolean): readonly Rule[] {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const settings = JSON.parse(content) as { permissions?: Permissions };
  return rulesFromPermissions(settings.permissions, readByClaudeCode);
}

type Permissions = {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
};

/** settings の permissions から Bash ルールを作る。regex はロード時にプリコンパイルする */
function rulesFromPermissions(permissions: Permissions | undefined, readByClaudeCode: boolean): readonly Rule[] {
  const rules: Rule[] = [];
  if (!permissions) return rules;

  const categories: readonly (readonly [RuleCategory, readonly string[]])[] = [
    ["allow", permissions.allow ?? []],
    ["deny", permissions.deny ?? []],
    ["ask", permissions.ask ?? []],
  ];

  for (const [category, patterns] of categories) {
    for (const pattern of patterns) {
      const bashPattern = extractBashPattern(pattern);
      if (bashPattern !== null) {
        rules.push({
          category,
          pattern,
          regex: patternToRegex(bashPattern),
          ...(readByClaudeCode && { readByClaudeCode: true as const }),
        });
      }
    }
  }

  return rules;
}

/** CLAUDE_PROJECT_DIR が絶対パスの実在ディレクトリならそのパス、それ以外は null */
function claudeProjectDir(env: Env): string | null {
  const dir = env.CLAUDE_PROJECT_DIR;
  if (dir === undefined || !isAbsolute(dir)) return null;
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * HOME が空でない絶対パスならそのパス、それ以外は null。
 * 空・相対パスを hook プロセスの作業ディレクトリ基準で解決しない。
 */
function homeDir(env: Env): string | null {
  const home = env.HOME;
  return home !== undefined && home !== "" && isAbsolute(home) ? home : null;
}

/**
 * managed settings (組織が配布する管理設定) の所在。
 * ref: https://code.claude.com/docs/en/managed-settings#where-each-mechanism-stores-the-policy
 */
export type ManagedSettingsSources = {
  /** managed-settings.json */
  readonly file: string;
  /** managed-settings.d (隠しファイル以外の `*.json` を名前順に読む) */
  readonly dropInDir: string;
  /** hook が内容を読まない管理ソース (macOS の MDM 管理プロファイル)。存在すれば hook allow しない */
  readonly opaque: readonly string[];
};

/**
 * OS ごとの managed settings の所在。Windows (`C:\Program Files\ClaudeCode` とレジストリ
 * HKLM / HKCU) 等、hook が扱わない OS は null (所在不明として hook allow しない)。
 * macOS の MDM 管理プロファイルは `com.anthropic.claudecode` ドメインの managed preferences
 * (端末全体とユーザごと)。
 */
export function defaultManagedSettingsSources(platform: NodeJS.Platform, user: string): ManagedSettingsSources | null {
  const managedPreferences = "/Library/Managed Preferences";
  const plist = "com.anthropic.claudecode.plist";
  switch (platform) {
    case "darwin":
      return {
        file: "/Library/Application Support/ClaudeCode/managed-settings.json",
        dropInDir: "/Library/Application Support/ClaudeCode/managed-settings.d",
        opaque: [join(managedPreferences, plist), join(managedPreferences, user, plist)],
      };
    case "linux":
      return {
        file: "/etc/claude-code/managed-settings.json",
        dropInDir: "/etc/claude-code/managed-settings.d",
        opaque: [],
      };
    default:
      return null;
  }
}

/** 実行中の OS とユーザの managed settings の所在 (ユーザ名が取れなければ null) */
function currentManagedSettingsSources(): ManagedSettingsSources | null {
  try {
    return defaultManagedSettingsSources(process.platform, userInfo().username);
  } catch {
    return null;
  }
}

/** パスに何か (壊れたシンボリックリンクを含む) があるか。存在を確認できないエラーは「ある」とする */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

class UninterpretableManagedSettings extends Error {}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * managed settings の 1 ファイルを読む。無ければ null。空ファイルは本体と同じく `{}`。
 * 読めない・JSON オブジェクトでない・permissions の allow / deny / ask が文字列の配列でない
 * ものは、deny / ask を取りこぼしうるので UninterpretableManagedSettings にする。
 */
function readManagedSettingsFile(path: string): Readonly<Record<string, unknown>> | null {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new UninterpretableManagedSettings(`${path} を読めない`);
  }
  let settings: unknown;
  try {
    settings = content.trim() === "" ? {} : JSON.parse(content);
  } catch {
    throw new UninterpretableManagedSettings(`${path} が JSON でない`);
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new UninterpretableManagedSettings(`${path} が JSON オブジェクトでない`);
  }
  const permissions = (settings as Record<string, unknown>).permissions;
  if (permissions !== undefined) {
    if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
      throw new UninterpretableManagedSettings(`${path} の permissions がオブジェクトでない`);
    }
    for (const key of ["allow", "deny", "ask"]) {
      const list = (permissions as Record<string, unknown>)[key];
      if (list !== undefined && !isStringArray(list)) {
        throw new UninterpretableManagedSettings(`${path} の permissions.${key} が文字列の配列でない`);
      }
    }
  }
  return settings as Record<string, unknown>;
}

/** managed-settings.d の `*.json` (隠しファイル以外) を名前順に。ディレクトリが無ければ空 */
function managedDropInFiles(dir: string): readonly string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new UninterpretableManagedSettings(`${dir} を読めない`);
  }
  return names
    .filter((name) => !name.startsWith(".") && name.endsWith(".json"))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * managed settings を deny / ask の判定用に読む (allow は hook allow の根拠にしない)。
 *
 * hookAllowable が false になる (hook allow しない) のは:
 * - 所在が分からない (sources が null)
 * - 内容を読まない管理ソース (MDM 管理プロファイル) が存在する
 * - 読めない / 解釈できないファイルがある (deny / ask を取りこぼしうる)
 * - allowManagedPermissionRulesOnly が false 以外 (本体は managed 以外の allow を使わず、
 *   不正な値は制限側に読む)
 */
function loadManagedRules(sources: ManagedSettingsSources | null): { rules: readonly Rule[]; hookAllowable: boolean } {
  if (sources === null) return { rules: [], hookAllowable: false };
  try {
    const documents = [sources.file, ...managedDropInFiles(sources.dropInDir)]
      .map(readManagedSettingsFile)
      .filter((settings) => settings !== null);
    const rules = documents.flatMap((settings) => rulesFromPermissions(settings.permissions as Permissions | undefined, false));
    const managedRulesOnly = documents.some(
      (settings) =>
        Object.hasOwn(settings, "allowManagedPermissionRulesOnly") && settings.allowManagedPermissionRulesOnly !== false,
    );
    return { rules, hookAllowable: !managedRulesOnly && !sources.opaque.some(pathExists) };
  } catch (e) {
    if (e instanceof UninterpretableManagedSettings) return { rules: [], hookAllowable: false };
    throw e;
  }
}

/**
 * ユーザー設定 + プロジェクト設定 + managed settings から Bash ルールを読み込んでマージする。
 *
 * 読み込み順（Codex / Claude Code 双方の設定をマージ）:
 * 0. managed settings (managed-settings.json, managed-settings.d/*.json)
 * 1. ~/.codex/settings.json
 * 2. ~/.claude/settings.json
 * 3. {cwd}/.codex/settings.json
 * 4. {cwd}/.codex/settings.local.json
 * 5. {cwd}/.claude/settings.json
 * 6. {cwd}/.claude/settings.local.json
 * 7. {CLAUDE_PROJECT_DIR}/.claude/settings.json
 * 8. {CLAUDE_PROJECT_DIR}/.claude/settings.local.json
 * 9. cwd と CLAUDE_PROJECT_DIR それぞれの git リポジトリのルートと、worktree なら main checkout
 *    のルートの .claude/settings.local.json (本体は local をそこから読む。localSettingsRootsOf)
 * (同じパスは 1 回だけ読む)
 *
 * ルールは全てマージされ、deny > allow > ask の順で評価される（matchCommand 側の責務）。
 * ただし `git -C <dir>` を正規化した候補は deny > ask > allow の順で評価する
 * (本体の ask ルールが -C 版に効かず、hook が唯一の適用点のため)。
 *
 * hook 自身の allow (Claude Code 本体の確認の省略) の根拠にしてよいのは、本体が実際に読む
 * ファイル由来の allow だけなので、そのルールに readByClaudeCode を付ける。対象は
 * ~/.claude/settings.json と、CLAUDE_PROJECT_DIR (Claude Code が hook に渡す、セッションを
 * 開始したプロジェクトルート) の .claude/settings.json / settings.local.json。
 * .codex/* と hook 入力の cwd 基準の .claude/* はリポジトリの内容 (エージェントが書ける /
 * clone 元が仕込める) で本体は読まないので付けない。managed settings と、9. (リポジトリ /
 * main checkout のルート) の allow にも付けない。
 * deny / ask は判定を厳しくする方向なので出自を問わず全て使う。
 *
 * hook が allow を返すと本体の deny / ask は -C 版に効かない (プレフィックス一致のため) ので、
 * 本体が読む deny / ask を hook が読み切れない構成では、どのルールにも付けない (hook は allow を返さない):
 * - CLAUDE_PROJECT_DIR が無い / 相対 / 実在しない: 本体の読む設定を特定できない
 * - CLAUDE_CONFIG_DIR が環境にある (値は問わない): 本体はユーザ設定を ~/.claude ではなく
 *   そこから読むが、hook はその所在を確実には追えない
 * - HOME が無い / 空 / 相対: 本体のユーザ設定の所在が分からない。~/ 配下の設定も読まない
 *   (hook プロセスの作業ディレクトリ基準で解決しない)
 * - managed settings の所在が分からない、読めない / 解釈できない、MDM 管理プロファイルがある、
 *   allowManagedPermissionRulesOnly が false 以外 (loadManagedRules)
 * - サーバー管理設定のキャッシュ (~/.claude/remote-settings.json) がある: サーバー管理設定は
 *   キャッシュと実際に適用中のポリシーが一致する保証が無く、hook は内容を評価しない
 * - cwd / CLAUDE_PROJECT_DIR が git リポジトリの中だが、本体が settings.local.json を読む
 *   ルートを特定できない (localSettingsRootsOf が null)
 *
 * env は HOME / CLAUDE_PROJECT_DIR / CLAUDE_CONFIG_DIR を読む環境変数、managed は managed
 * settings の所在 (いずれもテスト用、既定は実行中のプロセスと OS のもの)。
 * Codex は CLAUDE_PROJECT_DIR を渡さないので、Codex から起動された場合 hook は allow を返さない。
 */
export function loadRules(
  cwd?: string,
  env: Env = process.env,
  managed: ManagedSettingsSources | null = currentManagedSettingsSources(),
): readonly Rule[] {
  const home = homeDir(env);
  const projectDir = claudeProjectDir(env);
  const managedRules = loadManagedRules(managed);
  const sessionDirs = [...(cwd !== undefined && isAbsolute(cwd) ? [cwd] : []), ...(projectDir === null ? [] : [projectDir])];
  const localSettingsRoots = sessionDirs.map((dir) => localSettingsRootsOf(dir, env));
  const hookAllowable =
    projectDir !== null &&
    home !== null &&
    env.CLAUDE_CONFIG_DIR === undefined &&
    managedRules.hookAllowable &&
    !pathExists(join(home, ".claude", "remote-settings.json")) &&
    localSettingsRoots.every((roots) => roots !== null);
  const readByClaudeCode = new Set(
    !hookAllowable
      ? []
      : [
          resolve(home, ".claude", "settings.json"),
          resolve(projectDir, ".claude", "settings.json"),
          resolve(projectDir, ".claude", "settings.local.json"),
        ],
  );
  const paths = [
    ...(home === null ? [] : [resolve(home, ".codex", "settings.json"), resolve(home, ".claude", "settings.json")]),
    ...(cwd
      ? [
          resolve(cwd, ".codex", "settings.json"),
          resolve(cwd, ".codex", "settings.local.json"),
          resolve(cwd, ".claude", "settings.json"),
          resolve(cwd, ".claude", "settings.local.json"),
        ]
      : []),
    ...(projectDir === null
      ? []
      : [resolve(projectDir, ".claude", "settings.json"), resolve(projectDir, ".claude", "settings.local.json")]),
    ...localSettingsRoots.flatMap((roots) => (roots ?? []).map((root) => join(root, ".claude", "settings.local.json"))),
  ];

  const rules: Rule[] = [...managedRules.rules];
  for (const path of new Set(paths)) {
    rules.push(...loadRulesFromFile(path, readByClaudeCode.has(path)));
  }
  return rules;
}

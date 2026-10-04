import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { extractBashPattern, patternToRegex } from "./rule-matcher.ts";
import type { Rule, RuleCategory } from "./types.ts";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * 単一の settings.json から Bash ルールを読み込む。
 * ファイルが存在しない場合は空配列を返す。
 * regex はロード時にプリコンパイルする。
 */
function loadRulesFromFile(path: string, readByClaudeCode: boolean): readonly Rule[] {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const settings = JSON.parse(content) as {
    permissions?: {
      allow?: readonly string[];
      deny?: readonly string[];
      ask?: readonly string[];
    };
  };

  const rules: Rule[] = [];
  const permissions = settings.permissions;
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
 * ユーザー設定 + プロジェクト設定から Bash ルールを読み込んでマージする。
 *
 * 読み込み順（Codex / Claude Code 双方の設定をマージ）:
 * 1. ~/.codex/settings.json
 * 2. ~/.claude/settings.json
 * 3. {cwd}/.codex/settings.json
 * 4. {cwd}/.codex/settings.local.json
 * 5. {cwd}/.claude/settings.json
 * 6. {cwd}/.claude/settings.local.json
 * 7. {CLAUDE_PROJECT_DIR}/.claude/settings.json
 * 8. {CLAUDE_PROJECT_DIR}/.claude/settings.local.json
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
 * clone 元が仕込める) で本体は読まないので付けない。deny / ask は判定を厳しくする方向なので
 * 出自を問わず全て使う。
 * - CLAUDE_PROJECT_DIR が無い / 相対 / 実在しない: 本体の読む設定を特定できないので、
 *   どのルールにも付けない (hook は allow を返さない)
 * - CLAUDE_CONFIG_DIR が環境にある (値は問わない): 本体はユーザ設定を ~/.claude ではなく
 *   そこから読むが、hook はその所在を確実には追えない (deny / ask を取りこぼしうる) ので、
 *   どのルールにも付けない
 * - HOME が無い / 空 / 相対: 本体のユーザ設定の所在が分からないので、どのルールにも付けない。
 *   ~/ 配下の設定も読まない (hook プロセスの作業ディレクトリ基準で解決しない)
 *
 * env は HOME / CLAUDE_PROJECT_DIR / CLAUDE_CONFIG_DIR を読む環境変数 (テスト用、既定は process.env)。
 * Codex は CLAUDE_PROJECT_DIR を渡さないので、Codex から起動された場合の読み込み対象は従来どおり。
 */
export function loadRules(cwd?: string, env: Env = process.env): readonly Rule[] {
  const home = homeDir(env);
  const projectDir = claudeProjectDir(env);
  const hookAllowable = projectDir !== null && home !== null && env.CLAUDE_CONFIG_DIR === undefined;
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
  ];

  const rules: Rule[] = [];
  for (const path of new Set(paths)) {
    rules.push(...loadRulesFromFile(path, readByClaudeCode.has(path)));
  }
  return rules;
}

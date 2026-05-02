import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractBashPattern, patternToRegex } from "./rule-matcher.ts";
import type { Rule, RuleCategory } from "./types.ts";

/**
 * 単一の settings.json から Bash ルールを読み込む。
 * ファイルが存在しない場合は空配列を返す。
 * regex はロード時にプリコンパイルする。
 */
function loadRulesFromFile(path: string): readonly Rule[] {
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
        rules.push({ category, pattern, regex: patternToRegex(bashPattern) });
      }
    }
  }

  return rules;
}

/**
 * ユーザー設定 + プロジェクト設定から Bash ルールを読み込んでマージする。
 *
 * 読み込み順（Claude Code 公式の優先順位に準拠）:
 * 1. ~/.claude/settings.json（ユーザー設定）
 * 2. {cwd}/.claude/settings.json（プロジェクト共有設定）
 * 3. {cwd}/.claude/settings.local.json（プロジェクトローカル設定）
 *
 * ルールは全てマージされ、deny > allow > ask の順で評価される（matchCommand 側の責務）。
 */
export function loadRules(cwd?: string): readonly Rule[] {
  const home = process.env.HOME ?? "";
  const paths = [
    resolve(home, ".claude", "settings.json"),
    ...(cwd
      ? [
          resolve(cwd, ".claude", "settings.json"),
          resolve(cwd, ".claude", "settings.local.json"),
        ]
      : []),
  ];

  const rules: Rule[] = [];
  for (const path of paths) {
    rules.push(...loadRulesFromFile(path));
  }
  return rules;
}

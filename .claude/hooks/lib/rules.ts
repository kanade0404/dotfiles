import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rule, RuleCategory } from "./types.ts";

/**
 * settings.json から Bash ルールを読み込む。
 * Bash(...) パターンのみ抽出する。
 */
export function loadRules(settingsPath?: string): readonly Rule[] {
  const path =
    settingsPath ??
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "settings.json",
    );

  const content = readFileSync(path, "utf-8");
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
      if (pattern.startsWith("Bash(")) {
        rules.push({ category, pattern });
      }
    }
  }

  return rules;
}

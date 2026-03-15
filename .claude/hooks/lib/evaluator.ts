import { matchCommand } from "./rule-matcher.ts";
import type { Rule, RuleCategory } from "./types.ts";

export type EvaluationResult =
  | { decision: "deny"; denyReasons: readonly { command: string; pattern: string }[] }
  | { decision: "ask"; reason: string }
  | { decision: "allow" };

/**
 * サブコマンド群をルールで評価し、最終判定を返す。
 * 優先順位: deny > unmatched(ask) > ask > allow
 */
export function evaluateCommand(
  subCommands: readonly string[],
  rules: readonly Rule[],
): EvaluationResult {
  const denyReasons: { command: string; pattern: string }[] = [];
  const askReasons: string[] = [];
  const unmatchedReasons: string[] = [];

  for (const sub of subCommands) {
    const result = matchCommand(sub, rules);

    if (result === null) {
      unmatchedReasons.push(sub);
      continue;
    }

    switch (result.decision) {
      case "deny":
        denyReasons.push({ command: sub, pattern: result.pattern });
        break;
      case "ask":
        askReasons.push(sub);
        break;
      case "allow":
        break;
    }
  }

  if (denyReasons.length > 0) {
    return { decision: "deny", denyReasons };
  }

  if (unmatchedReasons.length > 0) {
    return {
      decision: "ask",
      reason: `ルールに未定義のコマンドが含まれています: ${unmatchedReasons.join(", ")}`,
    };
  }

  if (askReasons.length > 0) {
    return {
      decision: "ask",
      reason: `確認が必要なコマンドが含まれています: ${askReasons.join(", ")}`,
    };
  }

  return { decision: "allow" };
}

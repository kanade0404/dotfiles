export type HookInput = {
  readonly tool_name: string;
  readonly tool_input: {
    readonly command: string;
  };
  readonly cwd?: string;
};

/**
 * PreToolUse フックの出力型。
 * hookSpecificOutput.permissionDecision で制御する。
 * ref: https://code.claude.com/docs/en/hooks#pretooluse-decision-control
 */
export type HookOutput = {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: "allow" | "deny" | "ask";
    readonly permissionDecisionReason?: string;
  };
};

export type RuleCategory = "allow" | "deny" | "ask";

export type Rule = {
  readonly category: RuleCategory;
  readonly pattern: string;
  readonly regex: RegExp;
};

export type MatchResult = {
  readonly decision: RuleCategory;
  readonly command: string;
  readonly pattern: string;
} | null;

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
  /**
   * Claude Code 本体が実際に読む設定ファイル (rules.ts の loadRules 参照) 由来。
   * hook 自身の allow の根拠にできるのはこのルールだけ。
   */
  readonly readByClaudeCode?: true;
};

export type MatchResult = {
  readonly decision: RuleCategory;
  readonly command: string;
  readonly pattern: string;
  /**
   * `git -C <dir> <sub> ...` を `git <sub> ...` に正規化して allow ルールに一致した。
   * settings.json に `-C` 版ルールは無いため Claude Code 本体は自力で allow しない。
   */
  readonly gitCNormalized?: true;
} | null;

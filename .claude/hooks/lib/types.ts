export type HookInput = {
  readonly tool_name: string;
  readonly tool_input: {
    readonly command: string;
  };
  readonly cwd?: string;
  /**
   * Claude Code の permission mode ("default" / "plan" / "acceptEdits" / "auto" / "dontAsk" /
   * "bypassPermissions")。Codex や将来の値に備えて型は unknown で受け、hook-response.ts で検査する。
   * ref: https://code.claude.com/docs/en/hooks
   */
  readonly permission_mode?: unknown;
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
   * Claude Code 本体がどの構成でも適用する設定ファイル (ユーザ設定 ~/.claude/settings.json。
   * rules.ts の loadRules 参照) 由来。hook 自身の allow の根拠にできるのはこのルールのうち、
   * サブコマンドをリテラルで固定した git の allow だけ (evaluator.ts の rulesForHookAllow)。
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

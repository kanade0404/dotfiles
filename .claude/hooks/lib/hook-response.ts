import type { EvaluationResult } from "./evaluator.ts";

/**
 * hook を起動したクライアント。同じ pre-tool-use-bash-analyzer.ts が Claude Code
 * (`.claude/settings.json`) と Codex (`.codex/hooks.json`) の双方から呼ばれる
 * (install.sh が ~/.claude/hooks と ~/.codex/hooks の両方に symlink する)。
 */
export type HookClient = "claude-code" | "codex";

const CLAUDE_CODE_FLAG = "--client=claude-code";

/**
 * 起動引数からクライアントを決める。Claude Code 側の hook 登録だけが
 * `--client=claude-code` を渡す。引数が無い / 不明な場合は codex 扱いにする —
 * Codex は PreToolUse の bare な `permissionDecision: "allow"` (updatedInput 無し) を
 * unsupported として hook 失敗扱いにするため、allow を出さない側が安全な既定値。
 * 入力 JSON のフィールド (Codex 固有の turn_id 等) による推定は、両者のスキーマ変更で
 * 黙って判定が反転しうるので使わない。
 */
export function parseHookClient(argv: readonly string[]): HookClient {
  return argv.includes(CLAUDE_CODE_FLAG) ? "claude-code" : "codex";
}

/**
 * hook が allow を返してよい permission mode。それ以外 (未知の値・欠落を含む) では allow を返さない。
 * - plan: auto mode が使える環境では既定 (useAutoModeDuringPlan) で shell コマンドを classifier に回す。
 *   使えない環境でも組み込みの読み取り専用コマンド以外は確認を出す
 * - auto: classifier が確認の代わりに判定する (hook allow は classifier をスキップさせる)
 * - dontAsk: 確認になるはずの呼び出しを本体が拒否する (hook allow はそれを実行させる)
 * - bypassPermissions: 本体が確認を出さないので hook が allow する意味が無い
 * ref: https://code.claude.com/docs/en/permission-modes
 */
const HOOK_ALLOW_PERMISSION_MODES: ReadonlySet<string> = new Set(["default", "acceptEdits"]);

/**
 * hook 自身が `permissionDecision: "allow"` を出力するか。
 *
 * Claude Code では hook の allow は許可プロンプトを省略させる。本体の deny / ask
 * ルールは hook の allow 後も評価されるが、プレフィックス一致なので `git -C <dir> ...`
 * には一致しない。そのため -C 版の deny / ask は hook (rule-matcher の matchCommand) が
 * 正規化した `git <sub> ...` に deny > ask > allow の順で当て、ask に一致すれば
 * allow ではなく ask を返す。対象は evaluator が hookApproved を立てた `git -C`
 * 正規化済みコマンドだけで、それ以外の allow は従来どおり無出力 (pass-through) で
 * 本体の判定に委ねる。
 *
 * permissionMode は hook 入力 JSON の `permission_mode`
 * (https://code.claude.com/docs/en/hooks の common input fields: "default" / "plan" /
 * "acceptEdits" / "auto" / "dontAsk" / "bypassPermissions")。hook の allow は本体の確認だけでなく
 * auto mode の classifier もスキップさせるので、本体が allow ルールで自動許可し、残りを確認に
 * 回すモード (HOOK_ALLOW_PERMISSION_MODES) でだけ allow を出す。
 */
export function shouldEmitAllow(result: EvaluationResult, client: HookClient, permissionMode: unknown): boolean {
  return (
    client === "claude-code" &&
    result.decision === "allow" &&
    result.hookApproved &&
    typeof permissionMode === "string" &&
    HOOK_ALLOW_PERMISSION_MODES.has(permissionMode)
  );
}

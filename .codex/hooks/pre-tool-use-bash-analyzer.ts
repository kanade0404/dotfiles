import { parseShellCommands } from "./lib/shell-parser.ts";
import { matchCommand } from "./lib/rule-matcher.ts";
import { loadRules } from "./lib/rules.ts";
import { evaluateCommand } from "./lib/evaluator.ts";
import type { HookInput, HookOutput, RuleCategory } from "./lib/types.ts";

/** deny されたコマンドに対して代替ツールを案内するマッピング */
const TOOL_ALTERNATIVES: Readonly<Record<string, string>> = {
  ls: "Glob ツールまたは LS ツール",
  find: "Glob ツール",
  cat: "Read ツール",
  head: "Read ツール (offset/limit 指定)",
  tail: "Read ツール (offset/limit 指定)",
  grep: "Grep ツール",
  rg: "Grep ツール",
  sed: "Edit ツール",
  awk: "Grep ツールまたは Read ツール",
  echo: "直接テキスト出力",
  cd: "Bash コマンドで絶対パスを使用",
};

/** コマンド文字列の先頭ワード（コマンド名）を抽出する */
function extractCommandName(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

/** deny 理由行を組み立てる（パターン + 代替ツール案内） */
function formatDenyReason(sub: string, pattern: string): string {
  const cmdName = extractCommandName(sub);
  const alt = TOOL_ALTERNATIVES[cmdName];
  const base = `${sub} → ${pattern}`;
  return alt ? `${base} — 代わりに ${alt} を使用してください` : base;
}

/** HookOutput を stdout に書き出して終了する */
function respond(decision: RuleCategory, reason?: string): never {
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      ...(reason && { permissionDecisionReason: reason }),
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

function main(): void {
  let inputData = "";

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    inputData += chunk;
  });

  process.stdin.on("end", () => {
    try {
      const hookInput = JSON.parse(inputData) as HookInput;

      if (hookInput.tool_name !== "Bash") {
        process.exit(0);
        return;
      }

      const command = hookInput.tool_input.command;
      if (!command || command.trim() === "") {
        process.exit(0);
        return;
      }

      const rules = loadRules(hookInput.cwd);
      const subCommands = parseShellCommands(command);

      if (subCommands.length === 0) {
        process.exit(0);
        return;
      }

      const result = evaluateCommand(subCommands, rules);

      switch (result.decision) {
        case "deny": {
          const reasons = result.denyReasons.map((r) =>
            formatDenyReason(r.command, r.pattern),
          );
          respond("deny", `禁止コマンドが含まれています:\n  ${reasons.join("\n  ")}`);
          break;
        }
        case "ask":
          respond("ask", result.reason);
          break;
        case "allow":
          respond("allow");
          break;
      }
    } catch (e) {
      respond("ask", `コマンド解析エラー: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  });
}

main();

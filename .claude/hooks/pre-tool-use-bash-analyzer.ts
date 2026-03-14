import { parseShellCommands } from "./lib/shell-parser.ts";
import { matchCommand } from "./lib/rule-matcher.ts";
import { loadRules } from "./lib/rules.ts";
import type { HookInput, HookOutput } from "./lib/types.ts";

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
        // Bash 以外のツールはフォールスルー
        process.exit(0);
        return;
      }

      const command = hookInput.tool_input.command;
      if (!command || command.trim() === "") {
        process.exit(0);
        return;
      }

      const rules = loadRules();
      const subCommands = parseShellCommands(command);

      if (subCommands.length === 0) {
        process.exit(0);
        return;
      }

      let hasAsk = false;
      const askReasons: string[] = [];
      const blockReasons: string[] = [];

      for (const sub of subCommands) {
        const result = matchCommand(sub, rules);

        if (result === null) {
          // 未マッチ = allow（deny リストにないコマンドは許可）
          continue;
        }

        switch (result.decision) {
          case "deny": {
            blockReasons.push(formatDenyReason(sub, result.pattern));
            break;
          }
          case "allow": {
            // OK
            break;
          }
          case "ask": {
            hasAsk = true;
            askReasons.push(sub);
            break;
          }
        }
      }

      // deny が1つでもあれば deny
      if (blockReasons.length > 0) {
        const output: HookOutput = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `禁止コマンドが含まれています:\n  ${blockReasons.join("\n  ")}`,
          },
        };
        process.stdout.write(JSON.stringify(output));
        process.exit(0);
        return;
      }

      // ask があれば ask
      if (hasAsk) {
        const output: HookOutput = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: `確認が必要なコマンドが含まれています: ${askReasons.join(", ")}`,
          },
        };
        process.stdout.write(JSON.stringify(output));
        process.exit(0);
        return;
      }

      // 全て allow（未マッチも allow — deny リストにないコマンドは許可）
      const output: HookOutput = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      };
      process.stdout.write(JSON.stringify(output));
      process.exit(0);
    } catch (e) {
      // パースエラー等は ask（安全側に倒す、フォールスルーしない）
      const output: HookOutput = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `コマンド解析エラー: ${e instanceof Error ? e.message : "unknown error"}`,
        },
      };
      process.stdout.write(JSON.stringify(output));
      process.exit(0);
    }
  });
}

main();

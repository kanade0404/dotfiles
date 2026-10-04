import { matchCommand } from "./rule-matcher.ts";
import type { Rule, RuleCategory } from "./types.ts";

export type EvaluationResult =
  | { decision: "deny"; denyReasons: readonly { command: string; pattern: string }[] }
  | { decision: "ask"; reason: string }
  /**
   * hookApproved: hook 自身が allow を返してよい (Claude Code 本体の判定を待たずに
   * 実行を許可してよい) か。false の allow は従来どおり pass-through で本体に委ねる。
   */
  | { decision: "allow"; hookApproved: boolean };

/**
 * 許可済みのコマンドでも、実行内容がルール照合した文字列から変わりうる要素を含むか。
 *
 * - `$` / バッククォートによる展開 (シングルクォート内と ANSI-C `$'...'` は除く)
 * - ファイルへのリダイレクト / heredoc / プロセス置換 (fd 複製 `2>&1` と `/dev/null` は除く)
 * - 一時環境変数前置 (`GIT_EXEC_PATH=/evil git ...` 等で実行内容が変わる)
 *
 * hook 自身が allow を返す場合は Claude Code 本体のチェックを経ずに実行されるため、
 * これらを含むセグメントは hook の allow 対象から外して本体の判定に委ねる。
 */
export function hasExecutionHazard(segment: string): boolean {
  const s = segment.trim();
  if (/^[({\s]*[A-Za-z_][A-Za-z0-9_]*=/.test(s) || /^[({\s]*env\s/.test(s)) return true;

  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") { i++; continue; }
    if (quote === null && ch === "$" && s[i + 1] === "'") {
      // ANSI-C quoting はリテラル。閉じクォートまで読み飛ばす
      for (i += 2; i < s.length && s[i] !== "'"; i++) if (s[i] === "\\") i++;
      continue;
    }
    if (ch === "$" || ch === "`") return true;
    if (ch === '"') { quote = quote === '"' ? null : '"'; continue; }
    if (quote === '"') continue;
    if (ch === "'") { quote = "'"; continue; }
    if (ch === ">" || ch === "<") {
      const rest = s.slice(i);
      if (/^[<>]&(\d+|-)/.test(rest)) continue;
      const devNull = /^>>?\s*\/dev\/null(?=$|[\s;&|)])/.exec(rest);
      if (devNull) { i += devNull[0].length - 1; continue; }
      return true;
    }
  }
  return false;
}

/**
 * サブコマンドが「変数代入のみ」(例: `foo=$(git status)` や `A=1 B=2`) かを判定する。
 *
 * シェルでは `VAR=value` 単独は代入文でありコマンド実行ではない。`VAR=$(cmd)` の
 * 場合、内側 `cmd` は parseShellCommands で別サブコマンドとして抽出済みのため
 * 外側を unmatched として扱う必要はない。
 */
export function isAssignmentOnly(command: string): boolean {
  const s = command.trim();
  if (s === "") return false;
  const len = s.length;
  let i = 0;

  while (i < len) {
    const m = s.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!m) return false;
    i += m[0].length;

    while (i < len) {
      const c = s[i];
      if (c === " " || c === "\t") break;

      if (c === '"') {
        i++;
        while (i < len && s[i] !== '"') {
          if (s[i] === "\\" && i + 1 < len) {
            i += 2;
            continue;
          }
          i++;
        }
        if (i < len) i++;
        continue;
      }

      if (c === "'") {
        i++;
        while (i < len && s[i] !== "'") i++;
        if (i < len) i++;
        continue;
      }

      if (c === "$" && i + 1 < len && s[i + 1] === "(") {
        i += 2;
        let depth = 1;
        while (i < len && depth > 0) {
          if (s[i] === "(") depth++;
          else if (s[i] === ")") {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
          i++;
        }
        continue;
      }

      if (c === "`") {
        i++;
        while (i < len && s[i] !== "`") {
          if (s[i] === "\\" && i + 1 < len) {
            i += 2;
            continue;
          }
          i++;
        }
        if (i < len) i++;
        continue;
      }

      if (c === "\\" && i + 1 < len) {
        i += 2;
        continue;
      }

      i++;
    }

    while (i < len && (s[i] === " " || s[i] === "\t")) i++;
  }

  return true;
}

/**
 * サブコマンド群をルールで評価し、最終判定を返す。
 * 優先順位: deny > ask > allow(pass-through)
 *
 * 未定義コマンドは hook で判断せず pass-through (allow) する。Claude Code
 * 標準の default モードプロンプトに委ねることで、ユーザは「Yes, don't ask
 * again for `Bash(prefix *)`」を選んで自動的に allow ルールを増やせる。
 * hook 由来の ask ではこの選択肢が出ないため UX が悪化していた。
 *
 * 機密ファイルパスや危険な git フラグは rule-matcher 側で deny に昇格する
 * ので、pass-through 経路でも安全性は維持される。
 *
 * 例外は `git -C <dir> <sub>` で、settings.json に `-C` 版ルールを置かない
 * (rule-matcher の analyzeGitC 参照) ため本体は自力で allow しない。hook が正規化して
 * allow と判定したセグメントを含み、かつ全セグメントが明示 allow で実行時の副作用
 * (hasExecutionHazard) を持たない場合に限り hookApproved を立て、hook 自身が allow を
 * 返せるようにする。未定義コマンドや代入文が 1 つでも混ざれば全体を本体に委ねる。
 */
export function evaluateCommand(
  subCommands: readonly string[],
  rules: readonly Rule[],
): EvaluationResult {
  const denyReasons: { command: string; pattern: string }[] = [];
  const askReasons: string[] = [];
  let hasGitCNormalized = false;
  let allExplicitlyAllowed = true;

  for (const sub of subCommands) {
    if (isAssignmentOnly(sub)) {
      allExplicitlyAllowed = false;
      continue;
    }

    const result = matchCommand(sub, rules);

    if (result === null) {
      allExplicitlyAllowed = false;
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
        if (result.gitCNormalized) hasGitCNormalized = true;
        if (hasExecutionHazard(sub)) allExplicitlyAllowed = false;
        break;
    }
  }

  if (denyReasons.length > 0) {
    return { decision: "deny", denyReasons };
  }

  if (askReasons.length > 0) {
    return {
      decision: "ask",
      reason: `確認が必要なコマンドが含まれています: ${askReasons.join(", ")}`,
    };
  }

  return { decision: "allow", hookApproved: hasGitCNormalized && allExplicitlyAllowed };
}

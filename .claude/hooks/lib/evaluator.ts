import { isSameGitRepository } from "./git-repository.ts";
import { matchCommand, SIDE_EFFECT_FREE_GIT_GLOBAL_OPTS } from "./rule-matcher.ts";
import type { Rule, RuleCategory } from "./types.ts";

/**
 * zsh でも bash でも、クォートの外で何の意味も持たない (展開・区切り・リダイレクト・
 * glob・コメント・関数定義にならない) 文字。`=` と `~` は word 先頭でのみ展開される
 * (zsh の `=cmd` / `=(...)` 展開、チルダ展開) ので、PLAIN_WORD では位置を限って別に許す。
 */
const PLAIN_CHARS = "A-Za-z0-9_./:@,+%-";
/**
 * クォート無しの word。`=` は英数字 / `_` / `-` の直後、`~` は英数字 / `_` の直後に限る。
 * - word 先頭の `=`・`~` は zsh で展開される (`=ls` → `/bin/ls`、`=(cmd)` はプロセス置換)
 * - `==` や `=~` を許さないのは、zsh の MAGIC_EQUAL_SUBST が有効な環境で `--opt=` の後ろが
 *   word 先頭と同じに展開されるため
 * 例: `--format=%H` / `HEAD~1` は可、`=x` / `~/x` / `--x==ls` / `--x=~/y` は不可。
 */
const PLAIN_WORD = `[${PLAIN_CHARS}](?:[${PLAIN_CHARS}]|(?<=[A-Za-z0-9_-])=|(?<=[A-Za-z0-9_])~)*`;
/** シングル / ダブルクォートの word。中身は PLAIN_CHARS と半角スペースだけ (連結は不可) */
const QUOTED_WORD = `'[ ${PLAIN_CHARS}]*'|"[ ${PLAIN_CHARS}]*"`;
const WORD = `(?:${PLAIN_WORD}|${QUOTED_WORD})`;
/** サブコマンド: `-` で始まらないクォート無しの word */
const SUBCOMMAND = `(?!-)[${PLAIN_CHARS}]+`;
const GLOBAL_OPT = `(?:${[...SIDE_EFFECT_FREE_GIT_GLOBAL_OPTS]
  .map((opt) => opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|")})`;
const GIT_C_GRAMMAR = new RegExp(
  `^git(?: +${GLOBAL_OPT})* +-C +(${WORD})(?: +${GLOBAL_OPT})* +${SUBCOMMAND}(?: +${WORD})*$`,
);

/**
 * 生コマンド全体が、hook 自身が allow を返してよい厳密な正の文法に完全一致するか。
 *
 *   command := "git" (SP gopt)* SP "-C" SP word (SP gopt)* SP sub (SP word)*
 *   gopt    := SIDE_EFFECT_FREE_GIT_GLOBAL_OPTS のいずれか (値を取らないもの)
 *   word    := PLAIN_WORD | QUOTED_WORD
 *   SP      := 半角スペース 1 個以上
 *
 * 先頭は素の `git` 固定 (`time` / `env` / `command` / 代入 / `(` 等の前置は不可)、
 * `-C` は正確に 1 回、区切り・パイプ・リダイレクト・括弧・複数コマンドは不可。
 *
 * hook の allow は Claude Code 本体の確認を省略させる。実行シェルは zsh
 * (Claude Code の Bash tool はユーザの $SHELL で `eval` する) で、bash 前提の
 * パーサで危険な構文を除外する方式は、zsh 固有の構文 (関数定義 `name () cmd`、
 * `=(...)`、`time VAR=...` 等) を拾いきれず漏れが続いた。そこでシェルの構文を
 * モデル化せず、どのシェルでも単純コマンド 1 つとしか読めない字句だけを許す。
 * shell-parser / rule-matcher のトークナイザは使わない (パーサの解釈とのずれが
 * 許可判定に入り込まない構造にする)。
 */
export function isPlainGitCCommand(command: string): boolean {
  return GIT_C_GRAMMAR.test(command);
}

/**
 * isPlainGitCCommand の文法に一致する生コマンドから `-C` の引数をリテラルとして取り出す。
 * 文法の word はエスケープ・展開を含まないので、クォートを外すだけで実際の値になる。
 */
function plainGitCDirectory(command: string): string | null {
  const word = GIT_C_GRAMMAR.exec(command)?.[1];
  if (word === undefined) return null;
  return word.startsWith("'") || word.startsWith('"') ? word.slice(1, -1) : word;
}

export type EvaluationResult =
  | { decision: "deny"; denyReasons: readonly { command: string; pattern: string }[] }
  | { decision: "ask"; reason: string }
  /**
   * hookApproved: hook 自身が allow を返してよい (Claude Code 本体の判定を待たずに
   * 実行を許可してよい) か。false の allow は従来どおり pass-through で本体に委ねる。
   */
  | { decision: "allow"; hookApproved: boolean };

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
 * (rule-matcher の analyzeGitC 参照) ため本体は自力で allow しない。次を全て満たす
 * 場合に限り hookApproved を立て、hook 自身が allow を返せるようにする。
 * - 生コマンド (rawCommand) 全体が isPlainGitCCommand の文法 (単一の単純な
 *   `git ... -C <dir> ... <sub> ...`) に完全一致する
 * - 生コマンドを matchCommand で照合した結果が、正規化した `git <sub> ...` の
 *   非 -C allow への一致 (gitCNormalized) である (deny / 危険 git フラグ / 機密パスは
 *   matchCommand が先に判定する)
 * - `-C` の対象が hook 入力の cwd と同じ git common dir を持つ (isSameGitRepository)。
 *   別リポジトリの .git/config (core.fsmonitor 等) や .git/hooks 経由で確認無しに
 *   コマンドを実行させないため
 * 複合コマンドは文法に一致しないので、全セグメントが allow でも hook allow しない。
 * rawCommand / cwd を渡さない呼び出しは検査できないので hookApproved にしない。
 * env は isSameGitRepository に渡す環境変数 (テスト用、既定は process.env)。
 */
export function evaluateCommand(
  subCommands: readonly string[],
  rules: readonly Rule[],
  rawCommand?: string,
  cwd?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): EvaluationResult {
  const denyReasons: { command: string; pattern: string }[] = [];
  const askReasons: string[] = [];

  for (const sub of subCommands) {
    if (isAssignmentOnly(sub)) continue;

    const result = matchCommand(sub, rules);
    if (result === null) continue;

    switch (result.decision) {
      case "deny":
        denyReasons.push({ command: sub, pattern: result.pattern });
        break;
      case "ask":
        askReasons.push(sub);
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

  const dir = rawCommand === undefined ? null : plainGitCDirectory(rawCommand);
  const hookApproved =
    rawCommand !== undefined &&
    dir !== null &&
    matchCommand(rawCommand, rules)?.gitCNormalized === true &&
    isSameGitRepository(cwd, dir, env);
  return { decision: "allow", hookApproved };
}

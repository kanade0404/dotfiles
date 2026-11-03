import {
  COMMAND_PREFIXES,
  matchCommand,
  SHELL_KEYWORD_PREFIXES,
  SIDE_EFFECT_FREE_GIT_GLOBAL_OPTS,
  VARIABLE_REFERENCE_SOURCE,
} from "./rule-matcher.ts";
import type { Rule } from "./types.ts";

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
/** `-C` の引数は WORD か、ダブルクォートした変数参照 1 個 (値によらず 1 語)。ADR 0004 参照 */
const DIR_WORD = `(?:${PLAIN_WORD}|${QUOTED_WORD}|"${VARIABLE_REFERENCE_SOURCE}")`;
/** サブコマンド: `-` で始まらないクォート無しの word */
const SUBCOMMAND = `(?!-)[${PLAIN_CHARS}]+`;
const GLOBAL_OPT = `(?:${[...SIDE_EFFECT_FREE_GIT_GLOBAL_OPTS]
  .map((opt) => opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|")})`;
/**
 * どのシェルでも単純コマンド 1 つとしか読めない字句だけを許す正の文法 (ADR 0003 / 0004 参照)。
 * shell-parser のトークナイザは使わない (パーサの解釈とのずれを許可判定に入れないため)。
 */
const GIT_C_GRAMMAR = new RegExp(
  `^git(?: +${GLOBAL_OPT})* +-C +${DIR_WORD}(?: +${GLOBAL_OPT})* +${SUBCOMMAND}(?: +${WORD})*$`,
);
/** allow ルールは生のセグメントで照合するので、global option 付きの形は受け付けない */
const PLAIN_GIT_GRAMMAR = new RegExp(`^git +${SUBCOMMAND}(?: +${WORD})*$`);
const COMMAND_NAME = "[A-Za-z0-9_][A-Za-z0-9_.+-]*";
const SIMPLE_COMMAND_GRAMMAR = new RegExp(`^(${COMMAND_NAME})(?: +${WORD})*$`);
/** 改行・`&`・`|&` は区切りに含めない */
const SEPARATOR_OPERATOR = "(?:;|&&|\\|\\||\\|)";
const SEPARATOR = ` *${SEPARATOR_OPERATOR} *`;
const SEPARATOR_SPLIT = new RegExp(SEPARATOR);
/** 代入は含まない (COMMAND_NAME は `=` を含まない)。セグメントごとの文法は hookAllowSegments が当てる */
const SEGMENT = `${COMMAND_NAME}(?: +${DIR_WORD})*`;
const LIST_GRAMMAR = new RegExp(`^${SEGMENT}(?:${SEPARATOR}${SEGMENT})*$`);

/**
 * hook allow の根拠にしないコマンド名。組み込みはシェルの状態を変えて後続のセグメントの意味を変えうる。
 * ラッパーは allow の照合に使う名前と実際に実行されるコマンドがずれる。
 */
const NON_ALLOWABLE_COMMANDS: ReadonlySet<string> = new Set([
  ...SHELL_KEYWORD_PREFIXES,
  ...COMMAND_PREFIXES,
  // 予約語
  "if", "fi", "case", "esac", "for", "select", "while", "until", "done",
  "function", "coproc", "repeat", "foreach", "end", "nocorrect", "noglob",
  // zsh / bash の組み込みコマンド
  "alias", "autoload", "bg", "bind", "bindkey", "break", "builtin", "bye", "caller", "cap", "cd", "chdir",
  "clone", "compgen", "complete", "compopt", "continue", "declare", "dirs", "disable", "disown",
  "echotc", "echoti", "emulate", "enable", "eval", "exit", "export", "fc", "fg", "float",
  "functions", "getcap", "getln", "getopts", "hash", "help", "history", "integer", "jobs", "kill", "let",
  "limit", "local", "log", "logout", "mapfile", "popd", "print", "printf", "pushd", "pushln", "r", "read",
  "readarray", "readonly", "rehash", "return", "sched", "set", "setcap", "setopt", "shift", "shopt",
  "source", "stat", "strftime", "suspend", "times", "trap", "ttyctl", "type", "typeset", "ulimit", "umask", "unalias",
  "unfunction", "unhash", "unlimit", "unset", "unsetopt", "vared", "wait", "whence", "where", "which",
  "zcompile", "zformat", "zle", "zmodload", "zparseopts", "zprof", "zpty", "zregexparse", "zstyle",
  // ラッパー
  "sudo", "doas", "xargs", "timeout", "gtimeout", "stdbuf", "caffeinate", "arch",
  "script", "watch", "chroot", "setsid", "unbuffer", "ionice", "taskset", "flock",
]);

/**
 * `Bash(...)` の中身が `git <リテラルのサブコマンド>` で始まり、サブコマンドの直後が
 * 終端・空白・`:*` のいずれかである (サブコマンド位置に anchor される)。
 * 例: `git status *` / `git status:*` / `git stash list *` は可、
 * `*` / `git *` / `git:*` / `g*` / `git s*` / `git status*` / `git -C *` は不可。
 */
const SUBCOMMAND_ANCHORED_GIT_PATTERN = /^Bash\(git [A-Za-z0-9][A-Za-z0-9._-]*(?:\)$| |:\*\)$)/;

/** `Bash(...)` の中身がリテラルのコマンド名で始まる (コマンド名の位置に anchor される) */
const COMMAND_ANCHORED_PATTERN = new RegExp(`^Bash\\((${COMMAND_NAME})(?:\\)$| |:\\*\\)$)`);

/**
 * hook allow の判定に使うルール。deny / ask は出自を問わず残す。allow はユーザ設定由来 (readByClaudeCode) で、
 * サブコマンドかコマンド名をリテラルで固定したものに限る (広い allow は auto mode で本体が落とすため)。
 */
function rulesForHookAllow(rules: readonly Rule[]): readonly Rule[] {
  return rules.filter((rule) => {
    if (rule.category !== "allow") return true;
    if (rule.readByClaudeCode !== true) return false;
    if (SUBCOMMAND_ANCHORED_GIT_PATTERN.test(rule.pattern)) return true;
    const name = COMMAND_ANCHORED_PATTERN.exec(rule.pattern)?.[1];
    return name !== undefined && isAllowableCommandName(name);
  });
}

function isAllowableCommandName(name: string): boolean {
  return name !== "git" && !NON_ALLOWABLE_COMMANDS.has(name);
}

/**
 * 生コマンド全体を hook allow してよいか (条件は ADR 0004 参照)。
 * `-C` の無いセグメントでは matchCommand が allow を ask より先に見るので、deny / ask だけで改めて照合する。
 */
function hookAllowSegments(command: string, rules: readonly Rule[]): boolean {
  if (!LIST_GRAMMAR.test(command)) return false;
  const segments = command.split(SEPARATOR_SPLIT);
  const allowRules = rulesForHookAllow(rules);
  const blockingRules = rules.filter((rule) => rule.category !== "allow");
  const positiveRules = allowRules.filter((rule) => rule.category === "allow");
  const positivelyAllowed = (text: string) => positiveRules.some((rule) => rule.regex.test(text));
  let hasGitC = false;

  for (const text of segments) {
    if (GIT_C_GRAMMAR.test(text)) {
      const result = matchCommand(text, allowRules);
      if (result?.decision !== "allow" || result.gitCNormalized !== true) return false;
      hasGitC = true;
      continue;
    }
    if (matchCommand(text, blockingRules) !== null) return false;
    if (PLAIN_GIT_GRAMMAR.test(text)) {
      if (!positivelyAllowed(text)) return false;
      continue;
    }
    const name = SIMPLE_COMMAND_GRAMMAR.exec(text)?.[1];
    if (name === undefined || !isAllowableCommandName(name) || !positivelyAllowed(text)) {
      return false;
    }
  }
  return hasGitC;
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
 * `git -C` は settings.json に `-C` 版ルールが無く本体が自力で allow しないので、hookAllowSegments を
 * 満たすときだけ hookApproved を立てる (ADR 0004 参照)。rawCommand が無い呼び出しは検査できないので立てない。
 */
export function evaluateCommand(
  subCommands: readonly string[],
  rules: readonly Rule[],
  rawCommand?: string,
): EvaluationResult {
  const denyReasons: { command: string; pattern: string }[] = [];
  const askReasons: string[] = [];

  for (const sub of subCommands) {
    if (isAssignmentOnly(sub)) continue;

    const result = matchCommand(sub, rules);
    if (result?.decision === "deny") denyReasons.push({ command: sub, pattern: result.pattern });
    else if (result?.decision === "ask") askReasons.push(sub);
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

  const hookApproved = rawCommand !== undefined && hookAllowSegments(rawCommand, rules);
  return { decision: "allow", hookApproved };
}

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
/**
 * `-C` の位置だけで許す word。WORD に加えて、ダブルクォートした変数参照 1 個だけの word
 * (`"$R"` / `"${R}"`。値によらず 1 語のまま) を許す。変数参照は rule-matcher.ts と共有する。
 * クォートしない参照 (`$R`) は、zsh の配列・修飾子や bash の単語分割で語数が静的に決まらないので許さない。
 * 各選択肢は先頭の 2 文字までで排他になる (`"` の直後が `$` か PLAIN_CHARS か)。LIST_GRAMMAR で
 * word を繰り返したときに、一致しない入力でバックトラックが指数的に増えないようにする。
 */
const DIR_WORD = `(?:${PLAIN_WORD}|${QUOTED_WORD}|"${VARIABLE_REFERENCE_SOURCE}")`;
/** サブコマンド: `-` で始まらないクォート無しの word */
const SUBCOMMAND = `(?!-)[${PLAIN_CHARS}]+`;
const GLOBAL_OPT = `(?:${[...SIDE_EFFECT_FREE_GIT_GLOBAL_OPTS]
  .map((opt) => opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|")})`;
/**
 * `git -C` のセグメント。
 *
 *   segment := "git" (SP gopt)* SP "-C" SP dirword (SP gopt)* SP sub (SP word)*
 *   gopt    := SIDE_EFFECT_FREE_GIT_GLOBAL_OPTS のいずれか (値を取らないもの)
 *   word    := PLAIN_WORD | QUOTED_WORD
 *   dirword := word | "\"" varref "\""
 *   SP      := 半角スペース 1 個以上
 *
 * 先頭は素の `git` 固定 (`time` / `env` / `command` / 代入 / `(` 等の前置は不可)、`-C` は正確に 1 回。
 *
 * hook の allow は Claude Code 本体の確認を省略させる。実行シェルは zsh
 * (Claude Code の Bash tool はユーザの $SHELL で `eval` する) で、bash 前提の
 * パーサで危険な構文を除外する方式は、zsh 固有の構文 (関数定義 `name () cmd`、
 * `=(...)`、`time VAR=...` 等) を拾いきれず漏れが続いた。そこでシェルの構文を
 * モデル化せず、どのシェルでも単純コマンドとしか読めない字句だけを許す。
 * shell-parser / rule-matcher のトークナイザは使わない (パーサの解釈とのずれが
 * 許可判定に入り込まない構造にする)。
 */
const GIT_C_GRAMMAR = new RegExp(
  `^git(?: +${GLOBAL_OPT})* +-C +${DIR_WORD}(?: +${GLOBAL_OPT})* +${SUBCOMMAND}(?: +${WORD})*$`,
);
/**
 * `-C` の無い git。global option は付けられない (`git --no-pager log` は文法外)。
 * allow ルールの照合 (positivelyAllowed) は生のセグメントで行い、`Bash(git log *)` は
 * global option 付きの形に一致しないので、文法もそれに合わせる。
 */
const PLAIN_GIT_GRAMMAR = new RegExp(`^git +${SUBCOMMAND}(?: +${WORD})*$`);
/** git 以外の単純コマンド。コマンド名はパス・クォート・`=` を含まない素の名前 */
const COMMAND_NAME = "[A-Za-z0-9_][A-Za-z0-9_.+-]*";
const SIMPLE_COMMAND_GRAMMAR = new RegExp(`^(${COMMAND_NAME})(?: +${WORD})*$`);
/** セグメントの区切り演算子。改行・`&`・`|&` は含めない */
const SEPARATOR_OPERATOR = "(?:;|&&|\\|\\||\\|)";
/** 区切り (前後の空白を含む) */
const SEPARATOR = ` *${SEPARATOR_OPERATOR} *`;
/** 区切りで分割する (区切り自体は捨てる) */
const SEPARATOR_SPLIT = new RegExp(SEPARATOR);
/**
 * 区切りで分ける前の粗い文法。セグメントは「コマンド名 + DIR_WORD の並び」で、代入 (`R=/x`) は
 * 含まない (COMMAND_NAME は `=` を含まない)。セグメントごとの厳密な文法 (GIT_C_GRAMMAR /
 * PLAIN_GIT_GRAMMAR / SIMPLE_COMMAND_GRAMMAR) は hookAllowSegments が当てる。
 */
const SEGMENT = `${COMMAND_NAME}(?: +${DIR_WORD})*`;
const LIST_GRAMMAR = new RegExp(`^${SEGMENT}(?:${SEPARATOR}${SEGMENT})*$`);

/**
 * hook allow の対象にしない git 以外のコマンド名。シェルの予約語・組み込みコマンド
 * (zsh / bash) と、別のコマンドを起動するラッパー。状態を変えない組み込み (`echo` / `pwd` /
 * `true` / `false` / `test`) は含めない。
 * - 組み込みコマンドはシェルの状態 (変数・関数・alias・hash・オプション・作業ディレクトリ) を
 *   書き換えて後続のセグメントの意味を変えうる (`printf -v PATH ...`、`hash git=...` 等)
 * - ラッパーは allow ルールの照合 (コマンド名のプレフィックス一致) と実際に実行される
 *   コマンドがずれる (`command rm ...`、`nice rm ...`)
 */
const NON_ALLOWABLE_COMMANDS: ReadonlySet<string> = new Set([
  // rule-matcher.ts が deny 照合の前に剥がす予約語とラッパー (片方にだけ足してずれないよう共有する)
  ...SHELL_KEYWORD_PREFIXES,
  ...COMMAND_PREFIXES,
  // 予約語
  "if", "then", "else", "elif", "fi", "case", "esac", "for", "select", "while", "until", "do", "done",
  "function", "time", "coproc", "repeat", "foreach", "end", "nocorrect", "noglob",
  // zsh / bash の組み込みコマンド
  "alias", "autoload", "bg", "bind", "bindkey", "break", "builtin", "bye", "caller", "cap", "cd", "chdir",
  "clone", "command", "compgen", "complete", "compopt", "continue", "declare", "dirs", "disable", "disown",
  "echotc", "echoti", "emulate", "enable", "eval", "exec", "exit", "export", "fc", "fg", "float",
  "functions", "getcap", "getln", "getopts", "hash", "help", "history", "integer", "jobs", "kill", "let",
  "limit", "local", "log", "logout", "mapfile", "popd", "print", "printf", "pushd", "pushln", "r", "read",
  "readarray", "readonly", "rehash", "return", "sched", "set", "setcap", "setopt", "shift", "shopt",
  "source", "stat", "strftime", "suspend", "times", "trap", "ttyctl", "type", "typeset", "ulimit", "umask", "unalias",
  "unfunction", "unhash", "unlimit", "unset", "unsetopt", "vared", "wait", "whence", "where", "which",
  "zcompile", "zformat", "zle", "zmodload", "zparseopts", "zprof", "zpty", "zregexparse", "zstyle",
  // 別のコマンドを起動するラッパー
  "env", "nohup", "nice", "sudo", "doas", "xargs", "timeout", "gtimeout", "stdbuf", "caffeinate", "arch",
  "script", "watch", "chroot", "setsid", "unbuffer", "ionice", "taskset", "flock",
]);

/**
 * `Bash(...)` の中身が `git <リテラルのサブコマンド>` で始まり、サブコマンドの直後が
 * 終端・空白・`:*` のいずれかである (サブコマンド位置に anchor される)。
 * 例: `git status *` / `git status:*` / `git stash list *` は可、
 * `*` / `git *` / `git:*` / `g*` / `git s*` / `git status*` / `git -C *` は不可。
 */
const SUBCOMMAND_ANCHORED_GIT_PATTERN = /^Bash\(git [A-Za-z0-9][A-Za-z0-9._-]*(?:\)$| |:\*\)$)/;

/**
 * `Bash(...)` の中身が git 以外のリテラルのコマンド名で始まり、その直後が終端・空白・`:*` の
 * いずれかである (コマンド名の位置に anchor される)。例: `echo *` / `pwd` / `bun test *` は可、
 * `*` / `e*` / `echo*` は不可。コマンド名が NON_ALLOWABLE_COMMANDS のもの (`command *` 等) は
 * rulesForHookAllow が外す。
 */
const COMMAND_ANCHORED_PATTERN = new RegExp(`^Bash\\((${COMMAND_NAME})(?:\\)$| |:\\*\\)$)`);

/**
 * hook allow の判定に使うルール。deny / ask は出自を問わず残す (判定を厳しくする方向のため)。
 * allow は次の両方を満たすものだけに絞る。
 * - 本体が通常適用するユーザ設定由来 (readByClaudeCode。例外は ADR 0003 の既知の制約:
 *   `--setting-sources` / SDK の `settingSources` でユーザ設定を除いた構成)
 * - git ならサブコマンドをリテラルで固定した allow (SUBCOMMAND_ANCHORED_GIT_PATTERN)、
 *   git 以外ならコマンド名をリテラルで固定した allow (COMMAND_ANCHORED_PATTERN) で、
 *   コマンド名が組み込みコマンド・ラッパーでないもの。本体は auto mode で `Bash(*)` などの
 *   広い allow を落として classifier に回すので、広い allow は hook allow の根拠にしない
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

/** hook allow の根拠にしてよい git 以外のコマンド名か */
function isAllowableCommandName(name: string): boolean {
  return name !== "git" && !NON_ALLOWABLE_COMMANDS.has(name);
}

/**
 * 生コマンド全体を hook allow してよいか (evaluateCommand の hookApproved)。
 *
 * 次を全て満たす場合に限る。shell-parser の分解結果は使わず、生コマンドに正の文法を当てる。
 * - 生コマンド全体が「単純コマンドを `;` / `&&` / `||` / `|` で繋いだもの」の文法 (LIST_GRAMMAR) に
 *   一致する。代入 (`R=/x`)、クォートしない変数参照 (`-C $R`)、改行・ヒアドキュメント・リダイレクト・
 *   括弧・前置は文法外 (pass-through で本体の判定に委ねる)
 * - `git -C` のセグメントが 1 つ以上ある (-C が無いコマンドは従来どおり本体の判定に委ねる)
 * - 全セグメントが deny / ask (危険 git フラグ・機密パスを含む) のどれにも当たらず、allow ルールに
 *   肯定的に一致する (照合に使う allow は rulesForHookAllow)。どのルールにも一致しないセグメントが
 *   1 つでもあれば allow しない
 *   - `git -C` は GIT_C_GRAMMAR に一致し、matchCommand が正規化した `git <sub> ...` を allow に
 *     一致させる (gitCNormalized)。matchCommand は `-C` 付きのコマンドで deny > ask > allow の順に
 *     照合するので、allow の結果だけで deny / ask に当たらないことも分かる (呼び出しは 1 回)
 *   - `-C` の無い git は PLAIN_GIT_GRAMMAR、git 以外は SIMPLE_COMMAND_GRAMMAR に一致し (git 以外は
 *     コマンド名が組み込みコマンド・ラッパーでない)、生のセグメントが allow に一致する。matchCommand は
 *     `-C` の無いコマンドでは allow を ask より先に見るので、deny / ask は allow 以外のルールだけで
 *     改めて照合する (呼び出しは 1 回)
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
 * `git -C <dir> <sub>` は rule-matcher が `git <sub>` に正規化して判定する (ADR 0004)。
 * `-C` の引数がクォートしない変数参照 (`$R`) のときは、正規化した形と語が消えた形で deny を
 * 照合したうえで ask にする。zsh の配列や bash の単語分割で、展開後の語数を静的に決められないため。
 * `"$R"` とクォートした参照は 1 語に決まるので、リテラルの dir と同じく正規化する。
 *
 * settings.json に `-C` 版ルールを置かない (rule-matcher の analyzeGitC 参照) ため、本体は
 * `git -C` を自力で allow しない。生コマンド (rawCommand) 全体が hookAllowSegments の条件
 * (正の文法に一致し、全セグメントが deny / ask に当たらず allow ルールに肯定的に一致する) を
 * 満たす場合に限り hookApproved を立て、hook 自身が allow を返せるようにする。`-C` の対象
 * ディレクトリ (別リポジトリかどうか) は判定に使わない。代入とクォートしない変数参照を含む
 * コマンドは hookApproved にしない。rawCommand を渡さない呼び出しは検査できないので
 * hookApproved にしない。
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

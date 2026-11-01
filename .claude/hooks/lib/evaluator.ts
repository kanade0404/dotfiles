import { matchCommand, SIDE_EFFECT_FREE_GIT_GLOBAL_OPTS } from "./rule-matcher.ts";
import type { Rule } from "./types.ts";

type Env = Readonly<Record<string, string | undefined>>;

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
/** 変数名 (POSIX の名前規則) */
const NAME = "[A-Za-z_][A-Za-z0-9_]*";
/** 単純な変数参照 `$NAME` / `${NAME}` */
const VARIABLE_REFERENCE = `\\$(?:${NAME}|\\{${NAME}\\})`;
/**
 * `-C` の位置だけで許す word。WORD に加えて、ダブルクォート内の単純な変数参照
 * (`"$R"` / `"${R}/sub"`。値によらず 1 語のまま) と、クォート無しの変数参照 1 個
 * (`$R` / `${R}`。値が空なら語ごと消え、bash では空白で分割されるので、
 * hookAllowSegments が同じコマンド内の代入を条件にする) を許す。
 * 各選択肢は先頭の文字 (素の文字 / `'` / `"` / `$`) で排他にする (LIST_GRAMMAR で word を
 * 繰り返したときに、一致しない入力でバックトラックが指数的に増えないようにする)。
 */
const QUOTED_DIR_WORD = `"(?:[ ${PLAIN_CHARS}]|${VARIABLE_REFERENCE})*"`;
const DIR_WORD = `(?:${PLAIN_WORD}|'[ ${PLAIN_CHARS}]*'|${QUOTED_DIR_WORD}|${VARIABLE_REFERENCE})`;
/** サブコマンド: `-` で始まらないクォート無しの word */
const SUBCOMMAND = `(?!-)[${PLAIN_CHARS}]+`;
const GLOBAL_OPT = `(?:${[...SIDE_EFFECT_FREE_GIT_GLOBAL_OPTS]
  .map((opt) => opt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|")})`;
const GIT_C_SEGMENT = `git(?: +${GLOBAL_OPT})* +-C +(${DIR_WORD})(?: +${GLOBAL_OPT})* +${SUBCOMMAND}(?: +${WORD})*`;
const GIT_C_GRAMMAR = new RegExp(`^${GIT_C_SEGMENT}$`);
/** `-C` の無い git: global option は副作用の無いものだけ */
const PLAIN_GIT_GRAMMAR = new RegExp(`^git(?: +${GLOBAL_OPT})* +${SUBCOMMAND}(?: +${WORD})*$`);
/** git 以外の単純コマンド。コマンド名はパス・クォート・`=` を含まない素の名前 */
const COMMAND_NAME = "[A-Za-z0-9_][A-Za-z0-9_.+-]*";
const SIMPLE_COMMAND_GRAMMAR = new RegExp(`^(${COMMAND_NAME})(?: +${WORD})*$`);
/** 代入だけのセグメント。値は WORD (展開を含まない) か空 */
const ASSIGNMENT_GRAMMAR = new RegExp(`^(${NAME})=(${WORD})?$`);
/** セグメントの区切り。改行・`&`・`|&` は含めない */
const SEPARATOR = " *(?:;|&&|\\|\\||\\|) *";
/**
 * 区切りで分ける前の粗い文法。セグメントは代入か「コマンド名 + DIR_WORD の並び」で、
 * セグメントごとの厳密な文法 (GIT_C_GRAMMAR / PLAIN_GIT_GRAMMAR / SIMPLE_COMMAND_GRAMMAR) は
 * hookAllowSegments が当てる。2 つの選択肢は `=` の有無で排他 (COMMAND_NAME は `=` を含まない)。
 */
const SEGMENT = `(?:${NAME}=(?:${WORD})?|${COMMAND_NAME}(?: +${DIR_WORD})*)`;
const LIST_GRAMMAR = new RegExp(`^${SEGMENT}(?:${SEPARATOR}${SEGMENT})*$`);

/**
 * 生コマンド全体が、単一の `git ... -C <dir> ... <sub> ...` の厳密な正の文法に完全一致するか。
 *
 *   command := "git" (SP gopt)* SP "-C" SP dirword (SP gopt)* SP sub (SP word)*
 *   gopt    := SIDE_EFFECT_FREE_GIT_GLOBAL_OPTS のいずれか (値を取らないもの)
 *   word    := PLAIN_WORD | QUOTED_WORD
 *   dirword := word | QUOTED_DIR_WORD | VARIABLE_REFERENCE
 *   SP      := 半角スペース 1 個以上
 *
 * 先頭は素の `git` 固定 (`time` / `env` / `command` / 代入 / `(` 等の前置は不可)、
 * `-C` は正確に 1 回、区切り・パイプ・リダイレクト・括弧・複数コマンドは不可。
 * 複合コマンドは hookAllowSegments がこの文法をセグメント単位で使う。
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
 * hook allow の対象にしない git 以外のコマンド名。シェルの予約語・組み込みコマンド
 * (zsh / bash) と、別のコマンドを起動するラッパー。
 * - 組み込みコマンドはシェルの状態 (変数・関数・alias・hash・オプション・作業ディレクトリ) を
 *   書き換えて後続のセグメントの意味を変えうる (`printf -v PATH ...`、`hash git=...` 等)
 * - ラッパーは allow ルールの照合 (コマンド名のプレフィックス一致) と実際に実行される
 *   コマンドがずれる (`command rm ...`、`nice rm ...`)
 * 例外として HARMLESS_BUILTINS (状態を変えない組み込み) は許す。
 */
const NON_ALLOWABLE_COMMANDS: ReadonlySet<string> = new Set([
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
  "source", "stat", "suspend", "times", "trap", "ttyctl", "type", "typeset", "ulimit", "umask", "unalias",
  "unfunction", "unhash", "unlimit", "unset", "unsetopt", "vared", "wait", "whence", "where", "which",
  "zcompile", "zformat", "zle", "zmodload", "zparseopts", "zprof", "zpty", "zregexparse", "zstyle",
  // 別のコマンドを起動するラッパー
  "env", "nohup", "nice", "sudo", "doas", "xargs", "timeout", "gtimeout", "stdbuf", "caffeinate", "arch",
  "script", "watch", "chroot", "setsid", "unbuffer",
]);

/** 引数でシェルの状態を変えられない組み込みコマンド */
const HARMLESS_BUILTINS: ReadonlySet<string> = new Set(["echo", "pwd", "true", "false", "test"]);

/**
 * 代入するとシェル自身や後続のコマンドの挙動を変える変数 (大小文字を区別せずに比較する)。
 * 環境変数 (hook の環境にあるもの) は別に弾くので、ここに挙げるのは環境に無くても
 * シェルが特別扱いするもの。網羅ではない。
 */
const SPECIAL_VARIABLES: ReadonlySet<string> = new Set([
  "path", "ifs", "home", "cdpath", "fpath", "module_path", "mailpath", "manpath", "ps4", "env", "bash_env",
  "zdotdir", "prompt_command", "globignore", "shellopts", "bashopts", "posixly_correct", "nullcmd",
  "readnullcmd", "tmpprefix", "histfile",
]);
const SPECIAL_VARIABLE_PREFIXES = ["git_", "ld_", "dyld_", "bash_func"];

/**
 * 代入だけのセグメントで代入してよい変数名か。
 * 環境にある変数 (export 済みで子プロセスに渡る: PATH / HOME / PAGER 等) と、シェルが特別扱い
 * する変数 (IFS / zsh の path 等) は、代入すると後続の git や他のコマンドの実行内容が変わる
 * (`PATH=/tmp/evil; git -C . status`、`HOME=/tmp/x; git status` は /tmp/x/.gitconfig を読む)。
 * 大小文字を区別せずに比較する (zsh は `path` を `PATH` に連動させる)。
 */
function isAssignableName(name: string, env: Env): boolean {
  const lower = name.toLowerCase();
  if (SPECIAL_VARIABLES.has(lower) || SPECIAL_VARIABLE_PREFIXES.some((p) => lower.startsWith(p))) return false;
  return !Object.keys(env).some((key) => key.toLowerCase() === lower);
}

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
const COMMAND_ANCHORED_PATTERN = /^Bash\(([A-Za-z0-9_][A-Za-z0-9_.+-]*)(?:\)$| |:\*\)$)/;

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
    return name !== undefined && name !== "git" && isAllowableCommandName(name);
  });
}

function isAllowableCommandName(name: string): boolean {
  return HARMLESS_BUILTINS.has(name) || !NON_ALLOWABLE_COMMANDS.has(name);
}

/** 生コマンドを LIST_GRAMMAR で分けたセグメント */
type Segment =
  | { readonly kind: "assignment"; readonly name: string; readonly value: string; readonly index: number }
  | { readonly kind: "command"; readonly text: string; readonly index: number };

/**
 * 生コマンド全体が「単純コマンド・代入を `;` / `&&` / `||` / `|` で繋いだもの」という正の文法
 * (LIST_GRAMMAR) に完全一致すれば、セグメントと区切りに分けて返す。一致しなければ null。
 *
 * word の字句 (PLAIN_CHARS と、クォート内の半角スペース・変数参照) は区切りの文字
 * (`;` `&` `|`) を含まないので、文法に一致した文字列は区切りの位置でそのまま分割できる
 * (トークナイザを通さない)。改行・ヒアドキュメント・リダイレクト・括弧・展開
 * (`-C` の変数参照を除く) は文法外。
 */
function splitAllowableList(command: string): { segments: readonly Segment[]; separators: readonly string[] } | null {
  if (!LIST_GRAMMAR.test(command)) return null;
  const parts = command.split(/ *(;|&&|\|\||\|) */);
  const segments: Segment[] = [];
  const separators: string[] = [];
  for (let k = 0; k < parts.length; k++) {
    if (k % 2 === 1) {
      separators.push(parts[k]);
      continue;
    }
    const index = segments.length;
    const assignment = ASSIGNMENT_GRAMMAR.exec(parts[k]);
    segments.push(
      assignment
        ? { kind: "assignment", name: assignment[1], value: assignment[2] ?? "", index }
        : { kind: "command", text: parts[k], index },
    );
  }
  return { segments, separators };
}

/** クォートを外した代入値 (WORD はエスケープ・展開を含まない) */
function unquote(word: string): string {
  return word.startsWith("'") || word.startsWith('"') ? word.slice(1, -1) : word;
}

/**
 * クォート無しの `-C $NAME` が、空にも複数語にもならないことを同じコマンド内の代入で確かめる。
 * - index より前に、必ず実行される NAME の代入がある (先頭からその代入までの区切りが全て `;` で、
 *   直後の区切りが `|` でない。`|` の左辺はサブシェルで実行され代入が残らない)
 * - コマンド内の NAME の代入は全て値が空でなく、空白を含まない (条件付きの `R=` 等で空にされない。
 *   bash でも単語分割されない)
 * 変数を書き換える組み込みコマンド (read / unset / printf -v 等) は NON_ALLOWABLE_COMMANDS で
 * 文法上のセグメントから外れている。
 */
function isSafelyAssignedBefore(
  name: string,
  index: number,
  segments: readonly Segment[],
  separators: readonly string[],
): boolean {
  const assignments = segments.filter((s) => s.kind === "assignment" && s.name === name);
  if (assignments.some((s) => s.kind === "assignment" && !/^[^\s]+$/.test(unquote(s.value)))) return false;
  return assignments.some(
    (s) =>
      s.index < index &&
      separators.slice(0, s.index).every((sep) => sep === ";") &&
      separators[s.index] !== "|",
  );
}

/**
 * 生コマンド全体を hook allow してよいか (evaluateCommand の hookApproved)。
 *
 * 次を全て満たす場合に限る。shell-parser の分解結果は使わず、生コマンドに正の文法を当てる。
 * - 生コマンド全体が LIST_GRAMMAR に一致する (splitAllowableList)
 * - `git -C` のセグメントが 1 つ以上ある (-C が無いコマンドは従来どおり本体の判定に委ねる)
 * - 代入だけのセグメントは、代入してよい変数名 (isAssignableName) に限る
 * - 代入以外の全セグメントが allow ルールに肯定的に一致する (照合に使う allow は rulesForHookAllow)。
 *   deny / ask / どのルールにも一致しない (null) セグメントが 1 つでもあれば allow しない
 *   - `git -C` は GIT_C_GRAMMAR に一致し、正規化した `git <sub> ...` が allow に一致する
 *     (gitCNormalized)。`-C` の引数がクォート無しの変数参照なら isSafelyAssignedBefore も満たす
 *   - `-C` の無い git は PLAIN_GIT_GRAMMAR に一致し、サブコマンドを固定した git の allow に一致する
 *   - git 以外は SIMPLE_COMMAND_GRAMMAR に一致し、コマンド名が組み込みコマンド・ラッパーでなく、
 *     コマンド名を固定したユーザ設定の allow に生のセグメントが一致する
 */
function hookAllowSegments(command: string, rules: readonly Rule[], env: Env): boolean {
  const list = splitAllowableList(command);
  if (list === null) return false;
  const { segments, separators } = list;
  const allowRules = rulesForHookAllow(rules);
  const positivelyAllowed = (text: string) =>
    allowRules.some((rule) => rule.category === "allow" && rule.regex.test(text));
  let hasGitC = false;

  for (const segment of segments) {
    if (segment.kind === "assignment") {
      if (!isAssignableName(segment.name, env)) return false;
      continue;
    }
    const { text } = segment;
    const result = matchCommand(text, allowRules);
    if (result === null || result.decision !== "allow") return false;

    const gitC = GIT_C_GRAMMAR.exec(text);
    if (gitC !== null) {
      if (result.gitCNormalized !== true) return false;
      const variable = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(gitC[1]);
      const variableName = variable?.[1] ?? variable?.[2];
      if (variableName !== undefined && !isSafelyAssignedBefore(variableName, segment.index, segments, separators)) {
        return false;
      }
      hasGitC = true;
      continue;
    }
    if (PLAIN_GIT_GRAMMAR.test(text)) {
      if (!positivelyAllowed(text)) return false;
      continue;
    }
    const name = SIMPLE_COMMAND_GRAMMAR.exec(text)?.[1];
    if (name === undefined || name === "git" || !isAllowableCommandName(name) || !positivelyAllowed(text)) {
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
 * 例外は `git -C <dir> <sub>` を含むコマンドで、settings.json に `-C` 版ルールを置かない
 * (rule-matcher の analyzeGitC 参照) ため本体は自力で allow しない。生コマンド (rawCommand)
 * 全体が hookAllowSegments の条件 (正の文法に一致し、代入以外の全セグメントが allow ルールに
 * 肯定的に一致する。`git -C` は正規化した `git <sub> ...` で照合する) を満たす場合に限り
 * hookApproved を立て、hook 自身が allow を返せるようにする。`-C` の対象ディレクトリ
 * (別リポジトリかどうか) は判定に使わない (ADR 0004)。
 * rawCommand を渡さない呼び出しは検査できないので hookApproved にしない。
 * env は代入してよい変数名の判定 (isAssignableName) に使う環境変数 (テスト用、既定は process.env)。
 */
export function evaluateCommand(
  subCommands: readonly string[],
  rules: readonly Rule[],
  rawCommand?: string,
  env: Env = process.env,
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

  const hookApproved = rawCommand !== undefined && hookAllowSegments(rawCommand, rules, env);
  return { decision: "allow", hookApproved };
}

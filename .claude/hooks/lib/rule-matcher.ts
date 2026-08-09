import type { Rule, RuleCategory, MatchResult } from "./types.ts";

/**
 * Bash ルールパターンからコマンドパターン文字列を抽出する。
 * 例: "Bash(git status:*)" → "git status:*"
 */
export function extractBashPattern(rule: string): string | null {
  const match = rule.match(/^Bash\((.+)\)$/);
  return match ? match[1] : null;
}

/**
 * settings.json のパターンを正規表現に変換する。
 *
 * パターン形式:
 * - `:*` → 「プレフィックス後に何でもOK（空含む）」→ `( .*)?`
 * - ` *` (スペース+アスタリスク) → 「スペース+任意文字列」→ ` .*`
 * - `*` (単独) → 「任意文字列」→ `.*`
 */
export function patternToRegex(pattern: string): RegExp {
  // パターンを正規表現文字列に変換
  let regexStr = "";
  let i = 0;
  const len = pattern.length;

  while (i < len) {
    const ch = pattern[i];

    if (ch === ":" && i + 1 < len && pattern[i + 1] === "*") {
      // `:*` → 空文字列 or スペース+任意文字列
      // "task :*" のように :* の前にスペースがある場合、スペースを除去して統合
      if (regexStr.endsWith(" ")) {
        regexStr = regexStr.slice(0, -1);
      }
      regexStr += "( .*)?";
      i += 2;
      continue;
    }

    if (ch === " " && i + 1 < len && pattern[i + 1] === "*") {
      if (i + 2 >= len) {
        // パターン末尾の ` *` → 引数なし or 引数ありにマッチ（公式仕様準拠）
        regexStr += "( .*)?";
      } else {
        // パターン途中の ` *` → スペース+任意文字列
        regexStr += " .*";
      }
      i += 2;
      continue;
    }

    if (ch === "*") {
      // 単独 `*` → 任意文字列
      regexStr += ".*";
      i++;
      continue;
    }

    // 正規表現のメタ文字をエスケープ
    if (".+?^${}()|[]\\".includes(ch)) {
      regexStr += "\\" + ch;
    } else {
      regexStr += ch;
    }

    i++;
  }

  return new RegExp(`^${regexStr}$`, "s");
}

const SHELL_KEYWORD_PREFIXES = ["then", "else", "elif", "do"] as const;
const COMMAND_PREFIXES = [
  "env",
  "command",
  "exec",
  "nohup",
  "time",
  "nice",
] as const;

/**
 * `pos` から 1 トークン分の終端インデックスを返す (クォート / バックスラッシュ /
 * ANSI-C quoting を跨いで空白を消費する)。トークン境界の判定だけを行い、
 * 中身の復号はしない (復号は tokenizeCommand の担当)。
 */
function scanTokenEnd(input: string, pos: number): number {
  let i = pos;
  let quote: '"' | "'" | null = null;

  while (i < input.length) {
    const ch = input[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < input.length) { i += 2; continue; }
      if (ch === quote) { quote = null; i++; continue; }
      i++;
      continue;
    }
    // ANSI-C quoting は $' で開始し、内部のエスケープを跨いで ' まで
    if (ch === "$" && input[i + 1] === "'") {
      i += 2;
      while (i < input.length && input[i] !== "'") {
        i += input[i] === "\\" && i + 1 < input.length ? 2 : 1;
      }
      i++; // 閉じクォート
      continue;
    }
    // コマンド置換 $(...) はネストを数えながら跨ぐ。跨がないと
    // `FOO=$(evil arg) git reset --hard` の値が空白で切れて残余が壊れ、
    // 先頭トークンが git にならず最上位ガードまで落ちる。
    if (ch === "$" && input[i + 1] === "(") {
      let depth = 1;
      i += 2;
      while (i < input.length && depth > 0) {
        if (input[i] === "\\") { i += 2; continue; }
        if (input[i] === "(") depth++;
        else if (input[i] === ")") depth--;
        i++;
      }
      continue;
    }
    // バッククォートによるコマンド置換
    if (ch === "`") {
      i++;
      while (i < input.length && input[i] !== "`") {
        i += input[i] === "\\" ? 2 : 1;
      }
      i++;
      continue;
    }
    if (ch === "$" && input[i + 1] === '"') { quote = '"'; i += 2; continue; }
    if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
    if (ch === "\\" && i + 1 < input.length) { i += 2; continue; }
    if (/\s/.test(ch)) break;
    i++;
  }
  return i;
}

/**
 * git の作業ディレクトリ / リポジトリを付け替える環境変数。
 * `-C` / `--git-dir` / `--work-tree` と同じ「他リポジトリに届く」効果を持つ。
 */
const GIT_REDIRECT_ENV_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
];

/**
 * コマンド先頭の「一時環境変数前置」区間にある `NAME=value` トークンを返す。
 *
 * シェルキーワード / コマンド前置 / リダイレクト / `env` のフラグは読み飛ばし、
 * コマンド本体 (最初の素のトークン) に当たった時点で打ち切る。
 * スキップ対象は stripShellPrefixes と揃えること — 揃っていないと
 * 「コマンド本体は取り出せるのに env 情報だけ落ちる」非対称が穴になる。
 */
function envPrefixTokens(command: string): string[] {
  const tokens = tokenizeCommand(command.trim());
  const found: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    const redirectTok = /^(\d*(?:&>>|&>|>>|>&|<>|>|<))(.*)$/.exec(token);
    if (redirectTok) {
      if (redirectTok[2] === "") i++;
      continue;
    }

    const eq = token.indexOf("=");
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq))) {
      found.push(token);
      continue;
    }

    if (token === "-u" || token === "--unset") { i++; continue; }
    if (
      (SHELL_KEYWORD_PREFIXES as readonly string[]).includes(token) ||
      (COMMAND_PREFIXES as readonly string[]).includes(token) ||
      token === "{" ||
      token === "(" ||
      token.startsWith("-")
    ) {
      continue;
    }
    break;
  }
  return found;
}

/**
 * 一時環境変数前置に git のディレクトリ付け替え変数が含まれるかを判定する。
 *
 * `stripShellPrefixes` が env 前置を剥がした後に `findGitSubcommand` が走るため、
 * 剥がす前の文字列を見ないと redirect 情報が失われる
 * (`GIT_DIR=/other/.git git rm -rf .` が -C 版と違って素通りしてしまう)。
 */
function hasGitRedirectEnv(command: string): boolean {
  return envPrefixTokens(command).some((token) =>
    GIT_REDIRECT_ENV_VARS.includes(token.slice(0, token.indexOf("="))),
  );
}

/**
 * 先頭に連なる一時環境変数前置 (`VAR=val `) の合計長を返す。
 * 値はクォート / エスケープ / ANSI-C を跨いで 1 トークンとして消費するため、
 * `FOO='bar baz' git reset --hard` のような空白入りの値でも正しく剥がせる。
 * 後ろにコマンドが残らない場合は 0 を返す (代入だけの行は剥がさない)。
 */
function envAssignPrefixLength(cmd: string): number {
  let pos = 0;

  for (;;) {
    const m = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(cmd.slice(pos));
    if (!m) break;

    const valueEnd = scanTokenEnd(cmd, pos + m[0].length);
    // 次のトークンまでの空白を飛ばす
    let next = valueEnd;
    while (next < cmd.length && /\s/.test(cmd[next])) next++;
    // 後続に何も残らないなら前置ではない
    if (next >= cmd.length) break;

    pos = next;
  }

  return pos;
}

/**
 * シェル制御構文キーワードやコマンドプレフィックスを除去する。
 * 例: "then git push --force" → "git push --force"
 *     "env GIT_TRACE=1 git status" → "git status"
 */
export function stripShellPrefixes(command: string): string {
  let cmd = command.trim();

  // シェルキーワードの除去（先頭1語）
  for (const kw of SHELL_KEYWORD_PREFIXES) {
    if (cmd === kw || cmd.startsWith(kw + " ")) {
      cmd = cmd.slice(kw.length).trim();
      break;
    }
  }

  // { の除去（ブレースグループ）
  if (cmd.startsWith("{") && cmd.length > 1) {
    cmd = cmd.slice(1).trim();
  }

  // ( の除去（サブシェル / 二重括弧）
  while (cmd.startsWith("(")) {
    cmd = cmd.slice(1).trim();
  }

  // 末尾の ) の除去（サブシェル / 二重括弧）
  while (cmd.endsWith(")")) {
    cmd = cmd.slice(0, -1).trim();
  }

  // コマンドプレフィックスの除去（env VAR=val ... 対応含む）
  let changed = true;
  while (changed) {
    changed = false;

    // bash 標準の一時環境変数前置 (`VAR=val cmd`) を除去する。
    // `env VAR=val cmd` は下の env 分岐で剥がしていたのに素の形は残っており、
    // `FOO=bar git reset --hard` の先頭トークンが `FOO=bar` になって
    // 危険 git ガードの入口を素通りしていた。
    // 変数名は POSIX の名前規則 ([A-Za-z_][A-Za-z0-9_]*) に限定し、
    // `--format=%H` のようなフラグや、= を含むだけの引数を巻き込まないようにする。
    // 値の読み取りは scanTokenEnd に任せる — `\S*` だと
    // `FOO='bar baz' git reset --hard` を途中までしか剥がせず迂回できてしまう。
    const envAssignLen = envAssignPrefixLength(cmd);
    if (envAssignLen > 0) {
      cmd = cmd.slice(envAssignLen);
      changed = true;
      continue;
    }

    // 先頭のリダイレクト演算子 (`>/dev/null cmd` / `2>&1 cmd` / `>>out.txt cmd`)。
    // 剥がさないと先頭トークンが `>/dev/null` になり、コマンド名判定が
    // 素通りする (deny リストもプレフィックス一致なので当たらない)。
    // リダイレクト先の読み取りは scanTokenEnd に任せる — `\S*` だと
    // `>'a b' git reset --hard` がクォート内の空白で切れて残余が壊れる。
    const redirectOp = cmd.match(/^\d*(?:&>>|&>|>>|>&|<>|>|<)\s*/);
    if (redirectOp) {
      const targetEnd = scanTokenEnd(cmd, redirectOp[0].length);
      let next = targetEnd;
      while (next < cmd.length && /\s/.test(cmd[next])) next++;
      // 後続にコマンドが残る場合だけ剥がす
      if (next < cmd.length && next > redirectOp[0].length) {
        cmd = cmd.slice(next);
        changed = true;
        continue;
      }
    }

    for (const prefix of COMMAND_PREFIXES) {
      if (cmd === prefix || cmd.startsWith(prefix + " ")) {
        const wasEnv = prefix === "env";
        cmd = cmd.slice(prefix.length).trim();
        changed = true;

        // env の場合: フラグと KEY=VALUE を除去
        if (wasEnv) {
          // envフラグのスキップ
          let envFlagChanged = true;
          while (envFlagChanged) {
            envFlagChanged = false;
            // 値なしフラグ: -i, -0, --ignore-environment, --null
            const noArgMatch = cmd.match(/^(-i|--ignore-environment|-0|--null)\s+/);
            if (noArgMatch) {
              cmd = cmd.slice(noArgMatch[0].length);
              envFlagChanged = true;
              continue;
            }
            // --unset=NAME
            const unsetEqMatch = cmd.match(/^--unset=\S+\s*/);
            if (unsetEqMatch) {
              cmd = cmd.slice(unsetEqMatch[0].length);
              envFlagChanged = true;
              continue;
            }
            // -u NAME, --unset NAME
            const unsetMatch = cmd.match(/^(-u|--unset)\s+\S+\s*/);
            if (unsetMatch) {
              cmd = cmd.slice(unsetMatch[0].length);
              envFlagChanged = true;
              continue;
            }
            // -- (オプション終了マーカー)
            if (cmd.startsWith("-- ")) {
              cmd = cmd.slice(3);
              envFlagChanged = true;
              break;
            }
          }
          // KEY=VALUE の除去はここでは行わない。`env` を剥がした時点で changed=true
          // となり、次の while 反復の冒頭で素の前置と同じ envAssignPrefixLength が
          // 処理する (env 形式と素の形式で剥がし方を二重に持たない)。
        }
        break;
      }
    }
  }

  return cmd;
}

type DangerousGitFlagRule = {
  readonly gitSubcommands: readonly string[];
  readonly flags?: readonly string[];
  readonly prefixFlags?: readonly string[];
  readonly positionalArgs?: readonly string[];
  /**
   * フラグや位置引数を問わず、サブコマンドに一致した時点で危険と判定する。
   * settings.json 側でサブコマンドごと deny されているものに使う。
   */
  readonly alwaysDangerous?: boolean;
  /**
   * `-C` / `--git-dir` / `--work-tree` でディレクトリを付け替えている場合に限り
   * 危険と判定する。CWD 内では allow されている操作でも、付け替えると
   * プロジェクト外の任意リポジトリに届いてリスクの性質が変わるものに使う。
   */
  readonly dangerousWhenRedirected?: boolean;
  /**
   * `dangerousWhenRedirected` と併用。第 1 位置引数 (サブアクション) がここに
   * 挙がっていれば読み取りとみなし危険扱いしない。**挙がっていなければ危険**
   * (未知のサブアクションは安全側=危険側に倒す denylist ではなく allowlist)。
   * 位置引数が無い場合の既定は `bareIsReadOnly` で決める。
   */
  readonly readOnlySubActions?: readonly string[];
  /** 位置引数無し (`git stash` 等) が読み取り相当かどうか。既定は false=危険 */
  readonly bareIsReadOnly?: boolean;
};

const DANGEROUS_GIT_FLAGS: readonly DangerousGitFlagRule[] = [
  {
    // settings.json の `Bash(git reset *)` / `Bash(git rebase *)` /
    // `Bash(git checkout *)` はプレフィックス一致なので、`git -C <dir> reset --hard`
    // のように global option を挟まれるとマッチせず素通りしていた
    // (`Bash(git -C *)` の deny を外した際に開いた迂回経路)。
    // findGitSubcommand が -C / --git-dir / --work-tree / -c を正規化して読み飛ばした
    // 後のサブコマンドで捕捉し、ディレクトリ迂回の有無によらず同じ判定にする。
    // 読み取り系 (status / log / diff) と `git switch` は対象外なので影響しない。
    gitSubcommands: ["reset", "rebase", "checkout"],
    alwaysDangerous: true,
  },
  {
    // これらは allow リストに載っているが、その許可は「プロジェクトの CWD 内」を
    // 前提としたもの。`-C` / `--git-dir` / `--work-tree` で付け替えると
    // プロジェクト外の任意リポジトリにも同じ破壊的操作が届くため、
    // 付け替えがある場合に限って危険扱いにする。
    // (denylist なので網羅ではない。他の破壊系が見つかったらここに足す)
    gitSubcommands: [
      "rm", "update-ref", "clean", "filter-branch", "symbolic-ref",
      // 付け替え先リポジトリに作業ツリーやコミットを作る系。
      // `commit` は**意図的に含めない** — `git -C <repo> commit` は
      // (エージェントが絶対パスでリポジトリを操作する等) 正当な常用パターンで、
      // かつコミット作成自体はデータを失わない。含めると通常の作業が止まる。
      "cherry-pick", "revert", "worktree",
      // 付け替え先の作業ツリー / オブジェクトを壊す・書き換える系
      "restore", "mv", "apply", "checkout-index", "gc", "prune", "sparse-checkout",
      // config は core.fsmonitor / core.hooksPath / alias 等を別リポジトリに
      // 書き込めるため、そのリポジトリで次に git を叩いた時点で任意コマンド実行に
      // つながりうる。読み取り用途 (--get 等) より書き込みの危険が大きいので
      // 付け替え時は一律で危険扱いにする。
      "config",
    ],
    dangerousWhenRedirected: true,
  },
  {
    // git 自身が任意コマンドを起動する transport ヘルパー。
    // `--upload-pack` / `--receive-pack` は指定したコマンドをそのまま実行し、
    // `ext::` リモートは `ext::sh -c <cmd>` の形で任意コマンドを走らせる。
    // settings.json は `Bash(git fetch *)` 等を広く allow しているので、
    // ここで拾わないと auto-allow になる。
    gitSubcommands: ["fetch", "pull", "clone", "push", "remote", "submodule", "ls-remote", "archive"],
    flags: ["--upload-pack", "--receive-pack", "--exec"],
    prefixFlags: ["ext::"],
  },
  {
    // switch は通常のブランチ切替 (`switch main` / `switch -c new`) は安全だが、
    // -f / --discard-changes はローカル変更を破棄する点で `checkout -- .` と同性質。
    // checkout を alwaysDangerous にした以上、こちらだけ通す非対称は残せない。
    gitSubcommands: ["switch"],
    flags: ["-f", "--force", "--discard-changes"],
  },
  {
    // tag は一覧 (bare / -l) が読み取り。削除・強制付け替えが破壊的。
    gitSubcommands: ["tag"],
    dangerousWhenRedirected: true,
    flags: ["-d", "--delete", "-f", "--force"],
  },
  {
    // stash は list / show だけが読み取り。引数無しは stash push の省略形なので危険。
    gitSubcommands: ["stash"],
    dangerousWhenRedirected: true,
    readOnlySubActions: ["list", "show"],
    bareIsReadOnly: false,
  },
  {
    // reflog は引数無しだと show 相当なので読み取り。expire / delete が破壊的。
    gitSubcommands: ["reflog"],
    dangerousWhenRedirected: true,
    readOnlySubActions: ["show", "exists"],
    bareIsReadOnly: true,
  },
  {
    // notes は引数無しで一覧表示。
    gitSubcommands: ["notes"],
    dangerousWhenRedirected: true,
    readOnlySubActions: ["list", "show", "get-ref"],
    bareIsReadOnly: true,
  },
  {
    gitSubcommands: ["commit"],
    flags: ["--no-verify", "-n", "-a", "--all"],
  },
  {
    gitSubcommands: ["merge"],
    flags: ["--no-verify"],
  },
  {
    gitSubcommands: ["push"],
    flags: [
      "--force",
      "-f",
      "--force-with-lease",
      "--force-if-includes",
      "--delete",
      "-d",
      "--mirror",
      "--prune",
    ],
    prefixFlags: ["+", ":"],
  },
  {
    gitSubcommands: ["clean"],
    flags: ["-f", "--force", "-d", "-x", "-X"],
  },
  {
    // -f / --force は `git branch -f <name> <start>` で既存ブランチのポインタを
    // 強制的に付け替えられる (commit を失いうる)。settings.json 側は
    // `Bash(git branch *)` を allow しているので、ここで拾わないと素通りする。
    gitSubcommands: ["branch"],
    flags: ["-D", "-M", "-m", "--move", "--move-force", "-f", "--force"],
  },
  {
    gitSubcommands: ["restore"],
    positionalArgs: [".", "./"],
  },
  {
    gitSubcommands: ["add"],
    flags: ["-A", "--all", "-u", "--update"],
    positionalArgs: [".", "./"],
  },
];

/**
 * 引数のクォート・バックスラッシュ・ANSI-C quoting を正規化する。
 * シェルが解釈した後の実際の値に近づける。
 */
function normalizeArg(arg: string): string {
  // $'...' ANSI-C quoting を除去
  let s = arg.replace(/^\$'(.*)'$/s, "$1");
  // 先頭末尾のクォートを除去
  s = s.replace(/^['"]|['"]$/g, "");
  // バックスラッシュエスケープを除去（\- → -）
  s = s.replace(/\\(.)/g, "$1");
  return s;
}

/** ANSI-C quoting ($'...') の 1 エスケープを復号する。`\` の次の位置を受け取る。 */
function decodeAnsiCEscape(input: string, pos: number): { text: string; next: number } {
  const ch = input[pos];

  // \xHH — 16進 1〜2 桁
  if (ch === "x") {
    const m = /^[0-9a-fA-F]{1,2}/.exec(input.slice(pos + 1));
    if (m) return { text: String.fromCharCode(parseInt(m[0], 16)), next: pos + 1 + m[0].length };
  }
  // \uHHHH / \UHHHHHHHH
  if (ch === "u" || ch === "U") {
    const width = ch === "u" ? 4 : 8;
    const m = new RegExp(`^[0-9a-fA-F]{1,${width}}`).exec(input.slice(pos + 1));
    if (m) {
      const code = parseInt(m[0], 16);
      // 範囲外は復号せずリテラル扱い（例外を投げない）
      if (code <= 0x10ffff) {
        return { text: String.fromCodePoint(code), next: pos + 1 + m[0].length };
      }
    }
  }
  // \nnn — 8進 1〜3 桁
  if (ch >= "0" && ch <= "7") {
    const m = /^[0-7]{1,3}/.exec(input.slice(pos));
    if (m) return { text: String.fromCharCode(parseInt(m[0], 8) & 0xff), next: pos + m[0].length };
  }

  const simple: Record<string, string> = {
    a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f",
    n: "\n", r: "\r", t: "\t", v: "\v",
    "\\": "\\", "'": "'", '"': '"', "?": "?",
  };
  if (ch in simple) return { text: simple[ch], next: pos + 1 };

  // 未知のエスケープは bash 同様バックスラッシュごとリテラル扱い…ではなく、
  // ここでは「次の 1 文字」を採用する (従来 normalizeArg と同じ保守的な挙動)。
  return { text: ch ?? "", next: pos + 1 };
}

/**
 * コマンド文字列をシェル相当の規則でトークンに分割する。
 *
 * `split(/\s+/)` と違い、クォート内・バックスラッシュエスケープされた空白では
 * 区切らない。`git -C '/tmp/repo with spaces' reset --hard` の `-C` 引数を
 * 1 トークンとして保ち、subcommand の取り違えを防ぐのが目的。
 *
 * クォート自体は取り除く (シェルの quote removal 相当)。空のクォート (`''`) は
 * 空トークンとして残す — 落とすと `-C ''` の引数消費がずれて後続の subcommand を
 * `-C` の引数として食ってしまい、危険コマンドを取りこぼすため。
 */
function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      // 単一クォート内ではエスケープは効かない (シェルの挙動と同じ)
      if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        current += input[++i];
        continue;
      }
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }

    // ANSI-C quoting ($'...')。`$` を素の文字として積むとトークンが `$--force` に
    // 化けて、以降の normalizeArg の ANSI-C 分岐 (^\$'(.*)'$) にも入らなくなり、
    // フラグ比較から完全に漏れる。ここで剥がして中身を復号する。
    // 復号まで行わないと `$'\x72eset'` (= reset) や `$'\x2d\x2dforce'` (= --force) の
    // ように、bash が展開する形だけがガードを素通りする。
    if (ch === "$" && input[i + 1] === "'") {
      started = true;
      let j = i + 2;
      while (j < input.length && input[j] !== "'") {
        if (input[j] === "\\" && j + 1 < input.length) {
          const dec = decodeAnsiCEscape(input, j + 1);
          current += dec.text;
          j = dec.next;
          continue;
        }
        current += input[j];
        j++;
      }
      i = j; // 閉じクォート位置。for の i++ でその次へ進む
      continue;
    }

    // $"..." は locale translation quoting。翻訳カタログが無ければ中身がそのまま
    // 残るので、`$` を落として通常のダブルクォートとして扱う。
    // 放置すると `git $"reset" --hard` のトークンが `$reset` に化けて素通りする。
    if (ch === "$" && input[i + 1] === '"') { quote = '"'; started = true; i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === "\\" && i + 1 < input.length) { current += input[++i]; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || current.length > 0) { tokens.push(current); current = ""; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started || current.length > 0) tokens.push(current);

  return tokens;
}

/**
 * インライン `-c <key>=<value>` で指定されると任意コマンド実行につながる設定キー。
 *
 * `core.fsmonitor` は status / index 操作で即実行されるため、ディレクトリ付け替えすら
 * 不要でそのまま RCE になる。`config` サブコマンド経由の書き込みを塞いでいる以上、
 * より容易なこのインライン形を開けておく理由が無い。
 *
 * `core.pager` / `core.editor` は同じくコマンドを走らせるが、`-c core.pager=cat` の
 * ような正当な常用形があるため**意図的に含めない** (誤検知の害の方が大きい)。
 */
const RCE_CONFIG_KEY_PATTERN = /^(core\.(fsmonitor|hookspath|sshcommand)=|alias\.)/i;

/**
 * 指定するだけで git が任意コマンドを起動する環境変数。
 * `-c core.sshCommand=` 等と同じ RCE 経路を config を介さず開く。
 */
const RCE_ENV_VARS = [
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_EXTERNAL_DIFF",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  "GIT_SEQUENCE_EDITOR",
];

/** 値部分を持たない「キーだけ」の形 (GIT_CONFIG_KEY_N=<key>) 用 */
const RCE_CONFIG_KEY_ONLY_PATTERN = /^(core\.(fsmonitor|hookspath|sshcommand)|alias\..+)$/i;

/**
 * `git -c <key>=<value>` / `git --config-env=<key>=<var>` に RCE につながる
 * 設定キーが含まれるか。
 *
 * 走査は **subcommand より前の global option 区間だけ** に限る。全体を見ると
 * `git commit -c <commit-ish>` (メッセージ再利用フラグ) のような同名の
 * サブコマンドフラグまで inline config と誤認して誤 deny する。
 */
function hasDangerousInlineConfig(parts: readonly string[], subcommandIndex: number): boolean {
  for (let i = 1; i < subcommandIndex; i++) {
    const opt = normalizeArg(parts[i]).replace(/['"]/g, "");

    if (opt.startsWith("--config-env=")) {
      if (RCE_CONFIG_KEY_PATTERN.test(opt.slice("--config-env=".length))) return true;
      continue;
    }
    if (opt !== "-c" || i + 1 >= parts.length) continue;
    const cfg = normalizeArg(parts[i + 1]).replace(/['"]/g, "");
    if (RCE_CONFIG_KEY_PATTERN.test(cfg)) return true;
  }
  return false;
}

/**
 * 環境変数経由の config 注入に RCE 設定キーが含まれるか。
 *
 * git は `-c` 以外に `GIT_CONFIG_PARAMETERS` (内部的に `-c` を渡す仕組みそのもの) と
 * `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_N` / `GIT_CONFIG_VALUE_N` でも config を注入できる。
 * `-c` だけ塞いでも `core.fsmonitor` を仕込めば `git status` だけで任意コマンドが走るため、
 * 同じクラスとして扱う。
 */
function hasDangerousConfigEnv(command: string): boolean {
  // 走査は env 前置区間だけに限る。コマンド全体を見るとコミットメッセージ等の
  // 引数 (`git commit -m GIT_SSH_COMMAND=/evil`) まで拾って誤 deny する。
  for (const token of envPrefixTokens(command)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const name = token.slice(0, eq);
    const value = token.slice(eq + 1).replace(/['"]/g, "");

    // config を経由せず env 変数そのものがコマンドを走らせる形。
    // GIT_PAGER / GIT_EDITOR は core.pager / core.editor と同じ理由 (正当な常用形が
    // ある) で意図的に含めない。
    if (RCE_ENV_VARS.some((v) => v.toLowerCase() === name.toLowerCase())) return true;

    // GIT_CONFIG_PARAMETERS は "'key=value' 'key2=value2'" 形式
    if (/^GIT_CONFIG_PARAMETERS$/i.test(name)) {
      for (const pair of value.split(/\s+/)) {
        if (RCE_CONFIG_KEY_PATTERN.test(pair)) return true;
      }
      continue;
    }
    // GIT_CONFIG_KEY_<n>=<key>
    if (/^GIT_CONFIG_KEY_\d+$/i.test(name) && RCE_CONFIG_KEY_ONLY_PATTERN.test(value)) {
      return true;
    }
  }
  return false;
}

/**
 * git global optionsをスキップしてsubcommandとその引数を検出する。
 * 例: ["git", "-c", "key=val", "push", "--force"] → { subcommand: "push", argsStartIndex: 4 }
 */
function findGitSubcommand(parts: readonly string[]): {
  subcommand: string;
  argsStartIndex: number;
  /** -C / --git-dir / --work-tree でディレクトリを付け替えているか */
  redirected: boolean;
} | null {
  // 作業ディレクトリ / リポジトリを付け替える global options
  const redirectOpts = ["-C", "--git-dir", "--work-tree"];
  let redirected = false;
  // git global options一覧
  const singleGlobalOpts = [
    "--no-pager", "--bare", "--no-replace-objects", "--literal-pathspecs",
    "--glob-pathspecs", "--no-glob-pathspecs", "--no-optional-locks",
    "--paginate", "-p",
  ];
  const twoTokenGlobalOpts = ["-c", "-C", "--git-dir", "--work-tree", "--namespace"];

  let i = 1;
  while (i < parts.length) {
    // subcommand / global option の判定はクォートを剥がしてから行う。
    // `git 'reset' --hard` や `git re'set' --hard` のようにシェルが解釈すれば
    // 同じコマンドになる形で危険サブコマンドの判定を迂回されるのを防ぐ。
    // git の subcommand / global option は素の単語なので、途中のクォートも含めて
    // 全て除去してよい。
    const p = normalizeArg(parts[i]).replace(/['"]/g, "");
    // 2トークン消費するglobal options
    if (twoTokenGlobalOpts.includes(p) && i + 1 < parts.length) {
      if (redirectOpts.includes(p)) redirected = true;
      // `-c` 一般は付け替えではないが `-c core.worktree=<dir>` は実質
      // --work-tree と同じ効果を持つので redirect 扱いにする。
      if (p === "-c") {
        const cfg = normalizeArg(parts[i + 1]).replace(/['"]/g, "");
        if (/^core\.worktree=/i.test(cfg)) redirected = true;
      }
      i += 2;
      continue;
    }
    // --key=value 形式のglobal options
    if (p.startsWith("--") && p.includes("=")) {
      if (redirectOpts.includes(p.slice(0, p.indexOf("=")))) redirected = true;
      i++;
      continue;
    }
    // 単独global options
    if (singleGlobalOpts.includes(p)) { i++; continue; }
    // subcommandを発見（-で始まらない）
    if (!p.startsWith("-")) {
      return { subcommand: p, argsStartIndex: i + 1, redirected };
    }
    // 不明な-フラグ → 安全側でスキップ
    i++;
  }
  return null;
}

/**
 * git コマンドに位置非依存で危険なフラグが含まれているかチェックする。
 * 例: "git commit -m msg --no-verify" → true
 */
export function checkDangerousGitFlags(command: string): boolean {
  const stripped = stripShellPrefixes(command);

  // 空白区切りの単純 split ではなくシェル相当のトークナイズを行う。
  // `git -C '/tmp/repo with spaces' reset --hard` を split(/\s+/) で割ると
  // subcommand が "with" に化けて判定が落ちるため。
  const parts = tokenizeCommand(stripped);
  if (parts.length < 2) return false;

  // 入口の git 判定はコマンド名を正規化してから行う。matchCommand は本関数に
  // 正規化前の生コマンドを渡すので、`"git"` / `'git'` / `/usr/bin/git` の形だと
  // リテラル比較では素通りしてしまう (`Bash(git -C *)` の deny を外した以上、
  // `-C` 付きの破壊的 git はこのガードが最後の砦になる)。
  let name = normalizeArg(parts[0]).replace(/['"]/g, "");
  const lastSlash = name.lastIndexOf("/");
  if (lastSlash >= 0) name = name.slice(lastSlash + 1);
  if (name !== "git") return false;

  // env 経由の RCE 指定はサブコマンドに依らないので先に判定する
  // (`GIT_SSH_COMMAND=/evil git fetch` のように読み取り系でも成立する)。
  if (hasDangerousConfigEnv(command)) return true;

  const gitSub = findGitSubcommand(parts);
  if (!gitSub) return false;

  // インライン config も同様にサブコマンド非依存だが、走査範囲を
  // global option 区間に限るため subcommand を確定してから判定する。
  if (hasDangerousInlineConfig(parts, gitSub.argsStartIndex - 1)) return true;
  const subcommand = gitSub.subcommand;

  // ディレクトリ付け替えは global option だけでなく環境変数前置でも起きる。
  // env 前置は stripShellPrefixes が既に剥がしているので、元コマンドを見る。
  const redirected = gitSub.redirected || hasGitRedirectEnv(command);

  const args = parts.slice(gitSub.argsStartIndex);

  for (const rule of DANGEROUS_GIT_FLAGS) {
    if (!rule.gitSubcommands.includes(subcommand)) continue;

    // フラグを見るまでもなくサブコマンド自体が危険
    if (rule.alwaysDangerous) return true;

    // ディレクトリ付け替えがある場合のみ危険。付け替えが無ければこのルールは適用しない。
    // フラグ / 位置引数の条件を持つルールはそれも満たす必要があるので、
    // 条件が無いルールだけ即 true にして、あるものは下の通常判定に流す。
    if (rule.dangerousWhenRedirected) {
      if (!redirected) continue;

      // サブアクションの allowlist を持つルールは、それが読み取りなら安全。
      if (rule.readOnlySubActions) {
        const subAction = args.map(normalizeArg).find((a) => !a.startsWith("-"));
        if (subAction === undefined) {
          if (rule.bareIsReadOnly) continue;
          return true;
        }
        if (rule.readOnlySubActions.includes(subAction)) continue;
        return true;
      }

      if (!rule.flags && !rule.prefixFlags && !rule.positionalArgs) return true;
    }

    // subcommand がマッチした場合のみ正規化（遅延初期化）
    const normalizedArgs = args.map(normalizeArg);

    for (const flag of rule.flags ?? []) {
      if (flag.startsWith("--")) {
        // Vuln 1: long flag は =value 付きもマッチ（正規化後の引数でチェック）
        if (
          normalizedArgs.some((p) => p === flag || p.startsWith(flag + "="))
        )
          return true;
      } else if (flag.startsWith("-") && flag.length === 2) {
        // Vuln 2/3/6: short flag は結合フラグもマッチ（正規化後の引数でチェック）
        const char = flag[1];
        if (
          normalizedArgs.some(
            (p) => p.startsWith("-") && !p.startsWith("--") && p.includes(char),
          )
        )
          return true;
      }
    }

    // Vuln 5: prefixFlags は正規化後の引数で判定
    if (rule.prefixFlags) {
      for (const prefix of rule.prefixFlags) {
        if (normalizedArgs.some((p) => p.startsWith(prefix))) return true;
      }
    }

    // Vuln 4: 危険な位置引数のチェック（パス正規化付き）
    if (rule.positionalArgs) {
      for (const normalized of normalizedArgs) {
        // 完全一致
        if (rule.positionalArgs.includes(normalized)) return true;
        // パス正規化: "." か "./" が positionalArgs にある場合、等価パスもチェック
        if (
          rule.positionalArgs.includes(".") ||
          rule.positionalArgs.includes("./")
        ) {
          const pathNormalized = normalized.replace(/\/+$/, "");
          // ././. 等（カレントディレクトリの冗長表現）
          if (/^(\.\/?)+$/.test(pathNormalized)) return true;
          // ../ で始まる（親ディレクトリアクセス）
          if (pathNormalized.startsWith("..")) return true;
        }
      }
    }
  }
  return false;
}

/**
 * 機密ファイルパスのパターン一覧。
 * コマンド引数やリダイレクト先にこれらのパスが含まれていたらdenyに昇格する。
 */
const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  // SSH鍵・設定
  /[/~]\.ssh\//,
  /id_(rsa|ed25519|ecdsa|dsa)/,
  /authorized_keys/,
  /known_hosts/,
  // 秘密鍵・証明書
  /\.(pem|key|p12|pfx)(\s|$)/,
  // GPG
  /\.gnupg\//,
  // クレデンシャル
  /\.aws\/(credentials|config)/,
  /\.kube\/config/,
  /\.netrc/,
  /\.docker\/config\.json/,
  /\.npmrc/,
  /\.pypirc/,
  /\.config\/gh\/hosts\.yml/,
  // 環境変数
  /(^|\s|\/|<)\.env(\.[a-zA-Z]+)?(\s|$)/,
  // システム機密ファイル
  /\/etc\/(passwd|shadow|gshadow|master\.passwd)/,
  /\/etc\/sudoers/,
  // macOSキーチェーン
  /Library\/Keychains\//,
];

/**
 * クォートされた文字列リテラルを除去する。
 * コミットメッセージ等のテキスト引数内の機密パス名を誤検知しないため。
 */
function stripQuotedStrings(command: string): string {
  // ダブルクォート内を除去（エスケープ考慮）
  let result = command.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // シングルクォート内を除去
  result = result.replace(/'[^']*'/g, "''");
  return result;
}

/**
 * コマンド文字列に機密ファイルパスが含まれているかチェックする。
 * クォートされた文字列リテラル内のパスは無視する。
 */
export function checkSensitiveFilePaths(command: string): boolean {
  const stripped = stripQuotedStrings(stripShellPrefixes(command));
  return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(stripped));
}

/**
 * コマンド名からクォート・パスプレフィックス・バックスラッシュを除去して正規化する。
 * 例: "'rm' -rf /tmp" → "rm -rf /tmp"
 *     "/usr/bin/rm -rf /tmp" → "rm -rf /tmp"
 *     "r\m -rf /tmp" → "rm -rf /tmp"
 */
function normalizeCommandName(command: string): string {
  const spaceIndex = command.indexOf(" ");
  const originalName = spaceIndex === -1 ? command : command.slice(0, spaceIndex);
  const rest = spaceIndex === -1 ? "" : command.slice(spaceIndex);

  let cmdName = normalizeArg(originalName);
  // mid-word quoteの除去（シェルはクォート除去後に結合する）
  cmdName = cmdName.replace(/['"]/g, "");
  // フルパスからベース名を抽出
  const lastSlash = cmdName.lastIndexOf("/");
  if (lastSlash >= 0) {
    cmdName = cmdName.slice(lastSlash + 1);
  }

  if (cmdName === originalName) return command;
  return cmdName + rest;
}

/**
 * コマンドがルールパターンにマッチするか判定する。
 * マッチした場合、判定結果・コマンド・マッチしたパターンを返す。
 */
export function matchCommand(
  command: string,
  rules: readonly Rule[],
): MatchResult {
  // シェルプレフィックスを除去したコマンドも用意
  const stripped = stripShellPrefixes(command);
  const candidates = [command];
  if (stripped !== command) {
    candidates.push(stripped);
  }

  // コマンド名のクォート/パス/バックスラッシュを正規化した候補も追加
  for (const candidate of [...candidates]) {
    const normalized = normalizeCommandName(candidate);
    if (normalized !== candidate && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  }

  // クォート内を除去した候補も用意（コミットメッセージ等の文字列リテラル内の
  // 機密パス名がワイルドカードパターンに誤マッチしないため）
  const candidatesWithoutQuotes = candidates.map(stripQuotedStrings);

  // deny を最優先でチェック（クォート除去版でマッチ）
  for (const rule of rules) {
    if (rule.category !== "deny") continue;
    if (candidatesWithoutQuotes.some((cmd) => rule.regex.test(cmd))) {
      return { decision: "deny", command, pattern: rule.pattern };
    }
  }

  // 危険 git フラグの位置非依存チェック
  if (checkDangerousGitFlags(command)) {
    return { decision: "deny", command, pattern: "dangerous-git-flags" };
  }

  // 機密ファイルパスは allow ルールの有無に関わらず deny に昇格。
  // evaluator が未定義コマンドを pass-through (allow) するようになったため、
  // ここで早期チェックしないと機密パス操作が hook をすり抜ける。
  if (checkSensitiveFilePaths(command)) {
    return { decision: "deny", command, pattern: "sensitive-file-path" };
  }

  // allow チェック
  for (const rule of rules) {
    if (rule.category !== "allow") continue;
    if (candidates.some((cmd) => rule.regex.test(cmd))) {
      return { decision: "allow", command, pattern: rule.pattern };
    }
  }

  // ask チェック
  for (const rule of rules) {
    if (rule.category !== "ask") continue;
    if (candidates.some((cmd) => rule.regex.test(cmd))) {
      return { decision: "ask", command, pattern: rule.pattern };
    }
  }

  return null;
}

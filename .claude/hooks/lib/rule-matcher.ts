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
          // KEY=VALUE を除去
          while (/^\w+=\S*/.test(cmd)) {
            cmd = cmd.replace(/^\w+=\S*\s*/, "");
          }
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
    gitSubcommands: ["branch"],
    flags: ["-D", "-M", "-m", "--move", "--move-force"],
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
    // フラグ比較から完全に漏れる。ここで剥がして中身だけを残す。
    if (ch === "$" && input[i + 1] === "'") {
      started = true;
      let j = i + 2;
      while (j < input.length && input[j] !== "'") {
        if (input[j] === "\\" && j + 1 < input.length) { current += input[j + 1]; j += 2; continue; }
        current += input[j];
        j++;
      }
      i = j; // 閉じクォート位置。for の i++ でその次へ進む
      continue;
    }

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
 * git global optionsをスキップしてsubcommandとその引数を検出する。
 * 例: ["git", "-c", "key=val", "push", "--force"] → { subcommand: "push", argsStartIndex: 4 }
 */
function findGitSubcommand(parts: readonly string[]): {
  subcommand: string;
  argsStartIndex: number;
} | null {
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
    if (twoTokenGlobalOpts.includes(p) && i + 1 < parts.length) { i += 2; continue; }
    // --key=value 形式のglobal options
    if (p.startsWith("--") && p.includes("=")) { i++; continue; }
    // 単独global options
    if (singleGlobalOpts.includes(p)) { i++; continue; }
    // subcommandを発見（-で始まらない）
    if (!p.startsWith("-")) {
      return { subcommand: p, argsStartIndex: i + 1 };
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

  const gitSub = findGitSubcommand(parts);
  if (!gitSub) return false;
  const subcommand = gitSub.subcommand;

  const args = parts.slice(gitSub.argsStartIndex);

  for (const rule of DANGEROUS_GIT_FLAGS) {
    if (!rule.gitSubcommands.includes(subcommand)) continue;

    // フラグを見るまでもなくサブコマンド自体が危険
    if (rule.alwaysDangerous) return true;

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

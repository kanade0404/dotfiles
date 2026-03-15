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
};

const DANGEROUS_GIT_FLAGS: readonly DangerousGitFlagRule[] = [
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
    const p = parts[i];
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
  if (!stripped.startsWith("git ")) return false;

  // 空クォートペアを除去（""--force → --force）
  const sanitized = stripped.replace(/""|''/g, "");

  const parts = sanitized.split(/\s+/);
  if (parts.length < 2) return false;

  const gitSub = findGitSubcommand(parts);
  if (!gitSub) return false;
  const subcommand = gitSub.subcommand;

  const args = parts.slice(gitSub.argsStartIndex);

  for (const rule of DANGEROUS_GIT_FLAGS) {
    if (!rule.gitSubcommands.includes(subcommand)) continue;

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

  // deny を最優先でチェック
  for (const rule of rules) {
    if (rule.category !== "deny") continue;
    if (candidates.some((cmd) => rule.regex.test(cmd))) {
      return { decision: "deny", command, pattern: rule.pattern };
    }
  }

  // 危険 git フラグの位置非依存チェック
  if (checkDangerousGitFlags(command)) {
    return { decision: "deny", command, pattern: "dangerous-git-flags" };
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

/**
 * 状態機械ベースのシェルコマンドパーサー。
 * 複合コマンドを個別のサブコマンドに分解する。
 */

const State = {
  Normal: 0,
  SingleQuote: 1,
  DoubleQuote: 2,
  Escape: 3,
  DoubleQuoteEscape: 4,
  CommandSubstitution: 5,
  HereDoc: 6,
} as const;

type State = (typeof State)[keyof typeof State];

/**
 * シェルコマンド文字列を個別のサブコマンドに分解する。
 *
 * 処理する構文:
 * - パイプ: `|`, `|&`
 * - 論理演算子: `&&`, `||`
 * - セミコロン: `;`
 * - バックグラウンド: `&`（末尾のみ）
 * - 改行
 * - クォート内の演算子はスキップ
 * - エスケープ文字
 * - コマンド置換: `$(...)` 内のコマンドも抽出
 * - ヒアドキュメント: `<<EOF...EOF` のボディをスキップ
 */
export function parseShellCommands(input: string): readonly string[] {
  if (input.trim() === "") {
    return [];
  }

  const commands: string[] = [];
  let current = "";
  let i = 0;
  const len = input.length;
  let state: State = State.Normal;
  let parenDepth = 0;

  const pushCommand = () => {
    const trimmed = current.trim();
    if (trimmed !== "") {
      commands.push(trimmed);
    }
    current = "";
  };

  while (i < len) {
    const ch = input[i];

    switch (state) {
      case State.Normal: {
        // エスケープ
        if (ch === "\\") {
          if (i + 1 < len) {
            if (input[i + 1] === "\n") {
              // バックスラッシュ+改行 = 行継続（両方を除去）
              i += 2;
              continue;
            }
            current += ch + input[i + 1];
            i += 2;
            continue;
          }
          current += ch;
          i++;
          continue;
        }

        // シングルクォート
        if (ch === "'") {
          current += ch;
          state = State.SingleQuote;
          i++;
          continue;
        }

        // ダブルクォート
        if (ch === '"') {
          current += ch;
          state = State.DoubleQuote;
          i++;
          continue;
        }

        // コマンド置換 $(...)
        if (ch === "$" && i + 1 < len && input[i + 1] === "(") {
          current += "$(";
          i += 2;
          parenDepth = 1;
          state = State.CommandSubstitution;
          continue;
        }

        // ヒアドキュメント検出 <<[-]DELIMITER
        if (ch === "<" && i + 1 < len && input[i + 1] === "<") {
          const heredocResult = tryParseHereDoc(input, i);
          if (heredocResult) {
            current += heredocResult.consumed;
            i = heredocResult.endIndex;
            // ヒアドキュメント終了後はコマンド境界として扱う
            pushCommand();
            continue;
          }
        }

        // パイプ |, |&
        if (ch === "|") {
          if (i + 1 < len && input[i + 1] === "|") {
            // || 論理OR
            pushCommand();
            i += 2;
            continue;
          }
          if (i + 1 < len && input[i + 1] === "&") {
            // |& パイプ(stderr含む)
            pushCommand();
            i += 2;
            continue;
          }
          // | パイプ
          pushCommand();
          i++;
          continue;
        }

        // && 論理AND
        if (ch === "&" && i + 1 < len && input[i + 1] === "&") {
          pushCommand();
          i += 2;
          continue;
        }

        // &> or &>> リダイレクト
        if (ch === "&" && i + 1 < len && input[i + 1] === ">") {
          current += ch;
          i++;
          continue;
        }

        // N>&M リダイレクト（& の直前が > の場合）
        if (
          ch === "&" &&
          current.length > 0 &&
          current[current.length - 1] === ">"
        ) {
          current += ch;
          i++;
          continue;
        }

        // & バックグラウンド (末尾のみ分割)
        if (ch === "&") {
          // 末尾の & は無視（バックグラウンド実行）
          const remaining = input.slice(i + 1).trim();
          if (remaining === "") {
            pushCommand();
            i++;
            continue;
          }
          // 中間の & はセパレータ扱い
          pushCommand();
          i++;
          continue;
        }

        // セミコロン
        if (ch === ";") {
          pushCommand();
          i++;
          continue;
        }

        // 改行
        if (ch === "\n") {
          pushCommand();
          i++;
          continue;
        }

        current += ch;
        i++;
        break;
      }

      case State.SingleQuote: {
        current += ch;
        if (ch === "'") {
          state = State.Normal;
        }
        i++;
        break;
      }

      case State.DoubleQuote: {
        if (ch === "\\") {
          if (i + 1 < len && input[i + 1] === "\n") {
            // ダブルクォート内でもバックスラッシュ+改行は行継続
            i += 2;
            continue;
          }
          current += ch;
          if (i + 1 < len) {
            current += input[i + 1];
            i += 2;
            continue;
          }
          i++;
          continue;
        }
        current += ch;
        if (ch === '"') {
          state = State.Normal;
        }
        i++;
        break;
      }

      case State.CommandSubstitution: {
        if (ch === "\\" && i + 1 < len && input[i + 1] === "\n") {
          // コマンド置換内でもバックスラッシュ+改行は行継続
          i += 2;
          continue;
        }

        current += ch;

        if (ch === "\\") {
          if (i + 1 < len) {
            current += input[i + 1];
            i += 2;
            continue;
          }
          i++;
          continue;
        }

        if (ch === "'") {
          // シングルクォート内をスキップ
          i++;
          while (i < len && input[i] !== "'") {
            current += input[i];
            i++;
          }
          if (i < len) {
            current += input[i]; // closing '
            i++;
          }
          continue;
        }

        if (ch === '"') {
          // ダブルクォート内をスキップ
          i++;
          while (i < len) {
            if (input[i] === "\\" && i + 1 < len) {
              current += input[i] + input[i + 1];
              i += 2;
              continue;
            }
            if (input[i] === '"') {
              current += input[i];
              i++;
              break;
            }
            current += input[i];
            i++;
          }
          continue;
        }

        if (ch === "(") {
          parenDepth++;
          i++;
          continue;
        }

        if (ch === ")") {
          parenDepth--;
          if (parenDepth === 0) {
            state = State.Normal;
          }
          i++;
          continue;
        }

        i++;
        break;
      }

      default:
        current += ch;
        i++;
        break;
    }
  }

  pushCommand();
  return extractCommandSubstitutions(commands);
}

/**
 * コマンド置換 $(...) 内のコマンドを追加で抽出する。
 * 外側のコマンド全体はそのまま保持し、内側のコマンドも追加。
 */
function extractCommandSubstitutions(
  commands: readonly string[],
): readonly string[] {
  const result: string[] = [];

  for (const cmd of commands) {
    result.push(cmd);

    const innerCommands = extractInnerCommands(cmd);
    for (const inner of innerCommands) {
      const parsed = parseShellCommands(inner);
      for (const p of parsed) {
        result.push(p);
      }
    }
  }

  return result;
}

/**
 * 文字列中の $(...) / `...` / <(...) / >(...) から内側のコマンドを抽出する。
 */
function extractInnerCommands(input: string): readonly string[] {
  const results: string[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    // クォートスキップ
    if (ch === "'") {
      i++;
      while (i < len && input[i] !== "'") i++;
      if (i < len) i++;
      continue;
    }

    if (ch === '"') {
      i++;
      while (i < len) {
        if (input[i] === "\\" && i + 1 < len) {
          i += 2;
          continue;
        }
        if (input[i] === '"') {
          i++;
          break;
        }
        // ダブルクォート内の $() も抽出（シェルは展開する）
        if (input[i] === "$" && i + 1 < len && input[i + 1] === "(") {
          i += 2;
          let depth = 1;
          let inner = "";
          while (i < len && depth > 0) {
            if (input[i] === "(") depth++;
            else if (input[i] === ")") {
              depth--;
              if (depth === 0) break;
            }
            inner += input[i];
            i++;
          }
          if (inner.trim() !== "") {
            results.push(inner.trim());
          }
          if (i < len) i++; // skip closing )
          continue;
        }
        // ダブルクォート内のバッククォート置換 `...` も抽出（シェルは展開する）
        if (input[i] === "`") {
          i++;
          let inner = "";
          while (i < len && input[i] !== "`") {
            if (input[i] === "\\" && i + 1 < len) {
              inner += input[i + 1];
              i += 2;
              continue;
            }
            inner += input[i];
            i++;
          }
          if (inner.trim() !== "") {
            results.push(inner.trim());
          }
          if (i < len) i++; // skip closing `
          continue;
        }
        i++;
      }
      continue;
    }

    if (ch === "\\" && i + 1 < len) {
      i += 2;
      continue;
    }

    // バッククォート置換 `...` の検出
    if (ch === "`") {
      i++;
      let inner = "";
      while (i < len && input[i] !== "`") {
        if (input[i] === "\\" && i + 1 < len) {
          inner += input[i + 1];
          i += 2;
          continue;
        }
        inner += input[i];
        i++;
      }
      if (inner.trim() !== "") {
        results.push(inner.trim());
      }
      if (i < len) i++; // skip closing `
      continue;
    }

    // プロセス置換 <(...) / >(...) の検出
    if ((ch === "<" || ch === ">") && i + 1 < len && input[i + 1] === "(") {
      i += 2;
      let depth = 1;
      let inner = "";
      while (i < len && depth > 0) {
        if (input[i] === "(") depth++;
        else if (input[i] === ")") {
          depth--;
          if (depth === 0) break;
        }
        inner += input[i];
        i++;
      }
      if (inner.trim() !== "") {
        results.push(inner.trim());
      }
      if (i < len) i++; // skip closing )
      continue;
    }

    // $( 検出
    if (ch === "$" && i + 1 < len && input[i + 1] === "(") {
      i += 2;
      let depth = 1;
      let inner = "";
      while (i < len && depth > 0) {
        if (input[i] === "(") depth++;
        else if (input[i] === ")") {
          depth--;
          if (depth === 0) break;
        }
        inner += input[i];
        i++;
      }
      if (inner.trim() !== "") {
        results.push(inner.trim());
      }
      if (i < len) i++; // skip closing )
      continue;
    }

    i++;
  }

  return results;
}

/**
 * ヒアドキュメントの解析を試みる。
 * 成功した場合、消費した文字列と終了インデックスを返す。
 */
function tryParseHereDoc(
  input: string,
  startIndex: number,
): { consumed: string; endIndex: number } | null {
  let i = startIndex;
  const len = input.length;

  // << を消費
  if (i + 1 >= len || input[i] !== "<" || input[i + 1] !== "<") {
    return null;
  }
  i += 2;

  // オプションの - (<<- でインデント除去)
  if (i < len && input[i] === "-") {
    i++;
  }

  // 空白をスキップ
  while (i < len && (input[i] === " " || input[i] === "\t")) {
    i++;
  }

  // デリミタを読み取り（クォートされている場合も対応）
  let delimiter = "";
  if (i < len && (input[i] === "'" || input[i] === '"')) {
    const quote = input[i];
    i++;
    while (i < len && input[i] !== quote) {
      delimiter += input[i];
      i++;
    }
    if (i < len) i++; // closing quote
  } else {
    while (i < len && /[a-zA-Z0-9_]/.test(input[i])) {
      delimiter += input[i];
      i++;
    }
  }

  if (delimiter === "") {
    return null;
  }

  // 改行を探す
  const newlineIndex = input.indexOf("\n", i);
  if (newlineIndex === -1) {
    // ヒアドキュメントのボディがない → そのまま返す
    return { consumed: input.slice(startIndex, i), endIndex: i };
  }

  // デリミタ行を探す
  let searchFrom = newlineIndex + 1;
  while (searchFrom < len) {
    const lineEnd = input.indexOf("\n", searchFrom);
    const line =
      lineEnd === -1
        ? input.slice(searchFrom)
        : input.slice(searchFrom, lineEnd);

    if (line.trim() === delimiter) {
      const endIdx = lineEnd === -1 ? len : lineEnd + 1;
      return { consumed: input.slice(startIndex, endIdx), endIndex: endIdx };
    }

    if (lineEnd === -1) break;
    searchFrom = lineEnd + 1;
  }

  // デリミタが見つからない → 残り全部をヒアドキュメントとして消費
  return { consumed: input.slice(startIndex), endIndex: len };
}

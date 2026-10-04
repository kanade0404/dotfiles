# 3. git -C の許可判定を hook の正規化に一本化し、Claude Code でのみ hook が allow を返す

Date: 2026-10-04

## Status

Accepted

## Context

- エージェントは worktree や別リポジトリを `git -C <dir> <subcommand>` で操作することが多いが、`.claude/settings.json` の git 系 allow / deny はすべて `Bash(git status *)` のようなプレフィックス一致で、`git -C <dir> status` には一致しない。
- `Bash(git -C * status *)` のような中間ワイルドカードは、hook (`rule-matcher.ts` の `patternToRegex`) でも Claude Code 本体でもサブコマンド位置に anchor されない。「`-C` の後ろのどこかに空白 + `status` が現れる」コマンド全てに一致する。
  - allow 側: hook が動かない環境 (bun 不在、`~/.claude/hooks` 未配置、hook の実行エラーは non-blocking) では `git -C . submodule foreach <任意コマンド> status` や `git -C /x replace -d status` を本体が auto-approve する。
  - deny 側: `git -C /repo log -S reset` や `git -C /repo commit -m "fix rebase bug"` のような読み取り・通常操作まで本体が deny し、hook からもユーザの承認からも覆せない。
  - PR #272 の初版はこの形で実装し、レビュー (r4172068784 ほか計 7 スレッド) で上記が指摘された。
- 同じ `.claude/hooks/pre-tool-use-bash-analyzer.ts` が Claude Code (`.claude/settings.json`) と Codex (`.codex/hooks.json`) の両方から起動される (`install.sh` が `~/.claude/hooks` と `~/.codex/hooks` に symlink する)。従来の hook は「allow は返さず無出力で終了する」方針で、理由は Codex 互換だった。
- Claude Code の PreToolUse hook が返す `permissionDecision: "allow"` は許可プロンプトを省略させる。settings.json の deny / ask ルールは hook が allow を返しても引き続き適用される (<https://code.claude.com/docs/en/hooks>)。
- Codex は PreToolUse の `permissionDecision: "allow"` を `updatedInput` (入力の書き換え) と組み合わせた場合にしか受け付けない。bare な allow は `PreToolUse hook returned unsupported permissionDecision:allow` として hook 失敗扱いになる (openai/codex `codex-rs/hooks/src/engine/output_parser.rs`)。

## Decision

- settings.json には `git -C` 系の permission ルールを置かない。
- hook が `git [安全な global option] -C <dir> <sub> ...` を `git <sub> ...` に正規化し、非 -C の deny → 危険 git フラグの backstop (`checkDangerousGitFlags`) → 非 -C の allow の順で判定する。`-C` の引数がシェル展開を含む場合、`-C` を複数指定した場合、`--git-dir` / `--work-tree` / `-c` などの global option や `GIT_DIR` などの環境変数と併用した場合は ask にする。
- Claude Code から起動されたとき (hook 登録の起動引数 `--client=claude-code`) に限り、hook 自身が allow を返す。対象は次を全て満たすコマンドだけで、それ以外の allow は従来どおり無出力 (pass-through) にする。
  - コマンド全体が、hook のパーサが bash と同じに解釈すると言い切れる字句だけで書かれている (保守的ホワイトリスト、`evaluator.ts` の `isLexicallyPlain`)。クォート外は英数字・空白・`-_./:=@,+%^~` と制御演算子 `|&;()<>` に限る。クォート内は `$`・バッククォート・`\`・`#`・改行などの制御文字・空白類 (半角スペース以外) を含まず、ダブルクォート内は `!` も含まない。クォートの対応が取れている。
  - 正規化した `git -C` を含み、全セグメントが明示 allow である。
  - 全セグメントのコマンド名が `/`・クォート・エスケープを含まない素の名前で、allow への一致がコマンド名のパス除去・クォート除去を経ていない (`matchCommand` の `bareCommandName`)。
  - シェルのファイルリダイレクト・heredoc・env 前置・代入文を含まない。
- hook の allow は「パーサが完全に説明できる入力」に限るという原則を置く。パーサの字句解釈が bash とずれうる要素は、ずれを直すのではなく allow の対象から外して本体の判定に委ねる。
- Codex から起動されたとき、または起動引数が無い・不明なときは allow を返さない。

## Consequences

### Positive

- 本体側に anchor されないルールが無くなるので、hook が動かない環境でも `git -C` は本体のデフォルトプロンプトに落ちる。PR #272 以前と同じ安全側の挙動になる。
- `git -C` の判定が非 -C ルールと同じルール集合を使うので、`-C` 版ルールを手で複製して同期テストで追随させる必要が無くなる。
- `log -S reset` や commit メッセージ中の `rebase` のような語による過剰 deny が無くなる。

### Negative

- `git -C` の自動許可は hook だけに依存する。hook が動かない環境では、読み取り系の `git -C <dir> status` も毎回プロンプトになる。
- Claude Code 側の hook 登録に `--client=claude-code` が必須になる。Orca などが hook 登録を書き換えて引数が落ちると、自動許可が黙って無効になる (安全側の失敗であり、危険側には倒れない)。
- hook の allow は本体のコマンド解析を経ずに実行させるので、hook の正規化・分割ロジックの誤りがそのまま auto-approve に直結する。展開やリダイレクトを含むコマンドを allow 対象から外しているのはこのため。
  - 実例として、shell-parser が `#` コメント・改行・ANSI-C quoting (`$'...'`) 内の `\'` を bash と同じに扱わず、`git -C /r status #'` + 改行 + 任意コマンド や `git -C /r log $'\'' ; touch x #'` の後続コマンドが `git -C /r status` の 1 セグメントに吸収されて hook が allow を返していた。また、コマンド名のパスを除去してから照合するため `./git -C . status` や `git -C /r status; /tmp/evil/echo hi` も allow になっていた。いずれも字句ホワイトリストと素のコマンド名の条件で allow 対象から外した。
- 字句ホワイトリストは意図的に狭く、正当なコマンドも pass-through (本体のデフォルトプロンプト) に落ちる。許容するトレードオフとして、`git -C /r commit -m "fix #12"` のように `#` を含む commit メッセージ、`$` を含むフォーマット指定 (`--format='%H $x'`)、`\` を含む引数、glob / brace (`*` `{a,b}`)、ダブルクォート内の `!`、改行を含む複数行コマンドは hook の自動許可を受けない。
- `git -C <dir>` は任意のリポジトリの設定を読み込んで実行する。そのリポジトリの `core.fsmonitor`・`core.sshCommand`・`diff.external`・`protocol.ext.allow` と `ext::` remote などにより、`status` / `diff` / `fetch` のような allow 済みサブコマンドでも任意コマンドが実行されうる。hook はコマンド文字列しか見ないので、この実行面は防げない (非 -C でも CWD のリポジトリについて同じ面がある)。
- hook の保護は settings.json に `-C` 版ルールが無いことを前提にしている。ユーザが自分で `Bash(git -C * status *)` のような緩いルールを足した場合、本体がその緩いマッチで auto-approve するのを hook は止められない。
- Codex では `git -C` の自動許可が得られない (Codex 側の execpolicy の判定に委ねる)。

### Neutral

- 正規化できても非 -C allow に一致しないサブコマンド (`replace` / `submodule` 等) は ask ではなく pass-through にする。本体側に `-C` ルールが無いのでデフォルトプロンプトになり、ユーザが「次回から確認しない」で anchor されたルールを保存できる。
- allow 対象から外すのはシェルのファイルリダイレクトで、git 自身のオプションによるファイル書き込み (`git -C /r log --output=/tmp/x`) や外部コマンド起動 (`git -C /r diff --ext-diff`) は外さない。非 -C の `git log --output=...` / `git diff --ext-diff` も settings.json の allow で本体が自動許可しており、`-C` 版だけ厳しくしても挙動の差が増えるだけになる。また git は長いオプションの一意な省略形 (`--out=`) を受け付けるので、オプション名の denylist では網羅できない。これらを止めるべきと判断した場合は、非 -C と合わせて settings.json の deny / ask で扱う。
- Codex が bare な allow をサポートした場合、または Claude Code の hook allow の意味が変わった場合は、この決定を見直す。

## Alternatives Considered

### Option A: settings.json に `Bash(git -C * <sub> *)` の allow / deny を置く (PR #272 初版)

- 概要: 非 -C ルールを `-C` 版に複製し、hook は anchor 検査で緩いマッチを ask に倒す。
- 却下理由: 本体側の中間ワイルドカードは anchor されない。hook が動かないと本体が緩いマッチのまま auto-approve し、deny 側の過剰 deny は hook から覆せない。

### Option B: Option A を維持し、hook の導入を前提条件として README に明記する

- 概要: hook が必ず動くことを運用で担保する。
- 却下理由: hook の実行エラーは non-blocking で、settings.json は dotfiles として他マシンにも配られる。運用での担保では穴が残り、過剰 deny も解消しない。

### Option C: 入力 JSON のフィールド (Codex 固有の `turn_id` など) で Claude Code と Codex を判別する

- 概要: 起動引数を足さずに hook 内で推定する。
- 却下理由: どちらかのスキーマ変更で判定が黙って反転しうる。起動引数による明示指定は、欠落しても allow を出さない側に倒れる。

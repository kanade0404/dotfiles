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
- Claude Code から起動されたとき (hook 登録の起動引数 `--client=claude-code`) に限り、hook 自身が allow を返す。対象は「正規化した `git -C` を含み、全セグメントが明示 allow で、展開・ファイルへのリダイレクト・env 前置・代入文を含まない」コマンドだけで、それ以外の allow は従来どおり無出力 (pass-through) にする。
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
- Codex では `git -C` の自動許可が得られない (Codex 側の execpolicy の判定に委ねる)。

### Neutral

- 正規化できても非 -C allow に一致しないサブコマンド (`replace` / `submodule` 等) は ask ではなく pass-through にする。本体側に `-C` ルールが無いのでデフォルトプロンプトになり、ユーザが「次回から確認しない」で anchor されたルールを保存できる。
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

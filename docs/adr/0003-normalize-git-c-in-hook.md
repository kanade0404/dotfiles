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
- Claude Code の PreToolUse hook が返す `permissionDecision: "allow"` は許可プロンプトを省略させる。本体の deny / ask ルールは hook が allow を返した後も評価される (<https://code.claude.com/docs/en/hooks>) が、ルールはプレフィックス一致なので `Bash(git push *)` は `git -C <dir> push ...` に一致しない。`-C` 版のコマンドに deny / ask を適用できるのは hook だけになる。
- `git -C <dir>` は `<dir>` のリポジトリの設定 (`.git/config`) と `.git/hooks` を読み込んで実行する。`core.fsmonitor`・`diff.external`・`core.sshCommand` などを仕込んだリポジトリを対象にすると、`status` のような allow 済みのサブコマンドでも任意コマンドが実行される。エージェントは一時ディレクトリなどに `git init` してその `.git/config` を書けるので、対象を制限しない hook allow は確認無しの任意コマンド実行になる (PR #272 のレビューで、scratchpad に作った repo の `core.fsmonitor` が `git -C <dir> status` の hook allow で実行されることを再現した)。
- Claude Code の Bash tool はコマンドをユーザのシェル (本環境では `$SHELL` = zsh) で実行する。実体は `/bin/zsh -c '... setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL ... eval '<cmd>''` で、bash ではない。hook のパーサ (`shell-parser.ts` / `rule-matcher.ts`) は bash 寄りの部分的なモデルで、zsh の構文 (関数定義 `name () cmd`、`=(...)` / `=cmd` 展開、`time` の後の代入など) は扱わない。
- Codex は PreToolUse の `permissionDecision: "allow"` を `updatedInput` (入力の書き換え) と組み合わせた場合にしか受け付けない。bare な allow は `PreToolUse hook returned unsupported permissionDecision:allow` として hook 失敗扱いになる (openai/codex `codex-rs/hooks/src/engine/output_parser.rs`)。

## Decision

- settings.json には `git -C` 系の permission ルールを置かない。
- hook が `git [安全な global option] -C <dir> <sub> ...` を `git <sub> ...` に正規化し、非 -C の deny → 危険 git フラグの backstop (`checkDangerousGitFlags`) → 機密パス → 非 -C の ask → 非 -C の allow の順で判定する。ask に一致したら hook は ask を返す。
  - 非 -C のコマンドでは hook の照合順は allow → ask だが、非 -C は hook が allow を返さず (pass-through) 本体が deny > ask > allow の順で判定し直す。`-C` 版は本体の ask が効かないので、hook が ask を allow より先に当てないと、ユーザ設定の `ask: ["Bash(git push *)"]` が `-C` 版でだけ素通りする。
  - ask に一致したときに pass-through ではなく ask を返すのは、本体の ask ルールと同じく必ず確認を出すため。pass-through だと本体のデフォルトプロンプトになり、「次回から確認しない」で `-C` 版の allow ルールが保存されてユーザの ask を恒久的に迂回できてしまう。hook の ask は既存の経路 (ask ルールに一致した非 -C コマンド、正規化できない `-C`) でも返しており、Codex に対する出力の種類は増えない。`-C` の引数がシェル展開を含む場合、`-C` を複数指定した場合、`--git-dir` / `--work-tree` / `-c` などの global option や `GIT_DIR` などの環境変数と併用した場合は ask にする。
- Claude Code から起動されたとき (hook 登録の起動引数 `--client=claude-code`) に限り、hook 自身が allow を返す。対象は次を全て満たすコマンドだけで、それ以外の allow は従来どおり無出力 (pass-through) にする。
  - 生コマンド (`tool_input.command`) 全体が、次の厳密な正の文法に完全一致する (`evaluator.ts` の `isPlainGitCCommand`)。単一の単純コマンドだけを許し、先頭は素の `git` 固定、`-C` は正確に 1 回で、区切り (`;` `&&` `||` `|` `&`)・括弧・リダイレクト・前置 (`time` / `env` / `command` / `exec` / 代入など)・改行は含まない。

    ```text
    command := "git" (SP gopt)* SP "-C" SP word (SP gopt)* SP sub (SP word)*
    gopt    := SIDE_EFFECT_FREE_GIT_GLOBAL_OPTS (--no-pager / -P など値を取らないもの)
    sub     := "-" で始まらない plain+
    word    := plain (plain | "=" | "~")*  ※ "=" は英数字・"_"・"-" の直後、"~" は英数字・"_" の直後に限る
             | "'" (plain | " ")* "'" | "\"" (plain | " ")* "\""
    plain   := [A-Za-z0-9_./:@,+%-]
    SP      := 半角スペース 1 個以上
    ```

  - 生コマンドの照合結果が、正規化した `git <sub> ...` の非 -C allow への一致 (`gitCNormalized`) である。deny・危険 git フラグ・機密パス・ask の判定はこれより先に効く。
  - `-C` の対象ディレクトリが、hook 入力の `cwd` のリポジトリと同じ git common dir を持つ (`git-repository.ts` の `isSameGitRepository`)。つまり同一リポジトリ内のサブディレクトリか、同一リポジトリの worktree に限る。
    - git は実行せず、ファイルシステムだけで解決する。パスは `chdir(2)` と同じく 1 要素ずつシンボリックリンクを解決して物理的に辿る (`fs.realpathSync` は `link/..` を字句的に畳むので使わない)。祖先方向に `.git` を探し、ディレクトリならそれを gitdir、ファイルなら `gitdir: <path>` (相対パスは `.git` ファイルの位置基準) の参照先を gitdir とする。gitdir に `commondir` があればその参照先 (相対パスは gitdir 基準)、無ければ gitdir 自体を common dir とし、cwd 側も同様に解決して比較する。
    - 次はすべて allow しない (pass-through): cwd が無い・相対パス、`GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` / `GIT_CEILING_DIRECTORIES` などの環境変数が hook の環境にある、対象が存在しない・ディレクトリでない、`.git` ファイルの内容が不正、`.git` がシンボリックリンク、`.git` の無い階層に `HEAD` がある (bare リポジトリや `.git` 配下)、common dir の `config` か gitdir の `config.worktree` に `worktree` / `bare` (false 以外) / `[include` の行がある、読み取りエラー。submodule や入れ子のリポジトリは別の common dir に解決されるので一致しない。例外は hook 全体を落とさず「allow しない」に倒す。
- hook の allow は「どのシェルでも単一の単純コマンドとしか読めない字句」に限るという原則を置く。シェルの構文をモデル化して危険な形を除外する (denylist) のではなく、許す形を正の文法で列挙し (allowlist)、文法はトークナイザを通さず生文字列に直接当てる。パーサの解釈がシェルとずれても許可判定に入り込まない構造にする。
- `=` と `~` は zsh で word 先頭 (および `MAGIC_EQUAL_SUBST` 下の `=` の直後) にあるときだけ展開される (`=ls` → `/bin/ls`、`=(cmd)` はプロセス置換、`~/x` はチルダ展開)。`--format=%H` や `HEAD~1` を自動許可するため、展開されない位置に限って許す。
- Codex から起動されたとき、または起動引数が無い・不明なときは allow を返さない。

## Consequences

### Positive

- 本体側に anchor されないルールが無くなるので、hook が動かない環境でも `git -C` は本体のデフォルトプロンプトに落ちる。PR #272 以前と同じ安全側の挙動になる。
- `git -C` の判定が非 -C ルールと同じルール集合を使うので、`-C` 版ルールを手で複製して同期テストで追随させる必要が無くなる。
- `log -S reset` や commit メッセージ中の `rebase` のような語による過剰 deny が無くなる。

### Negative

- `git -C` の自動許可は hook だけに依存する。hook が動かない環境では、読み取り系の `git -C <dir> status` も毎回プロンプトになる。
- Claude Code 側の hook 登録に `--client=claude-code` が必須になる。Orca などが hook 登録を書き換えて引数が落ちると、自動許可が黙って無効になる (安全側の失敗であり、危険側には倒れない)。
- hook の allow は本体のコマンド解析を経ずに実行させるので、hook の判定の誤りがそのまま auto-approve に直結する。
  - 経緯: 当初は shell-parser でセグメントに分割し、全セグメントが allow で危険な字句 (展開・リダイレクト・env 前置) を含まなければ hook allow していた。2 度のレビューで、シェルを部分的にモデル化した許可条件から次の漏れが続けて見つかった。
    - 1 度目: `#` コメント + 改行 (`git -C /r status #'` + 改行 + 任意コマンド)、ANSI-C quoting 内の `\'` (`git -C /r log $'\'' ; touch x #'`)、パス付きコマンド名 (`./git -C . status`、`git -C /r status; /tmp/evil/echo hi`)。字句ホワイトリストと素のコマンド名の条件で塞いだ。
    - 2 度目: 実行シェルが zsh であることを前提にしていなかった。関数定義による allow 済みコマンド名の再定義 (`echo () (touch X); git -C R status; echo`)、zsh の `=(...)` プロセス置換 (`git -C R status =(touch X)`)、`time` の後の env 代入 (`time GIT_TRACE=X git -C R status`、env の deny も迂回)、fd 複製の後ろのファイル名 (`git -C R log -1 >&1mk` は `1mk` へ書き込む)。
  - 漏れは個別の構文ではなく「部分的なモデルで除外する」方式に起因するので、生コマンド全体への正の文法に切り替えた。文法に一致した入力は zsh (Claude Code の setopt、`EXTENDED_GLOB` / `MAGIC_EQUAL_SUBST` / `RC_QUOTES` 有効時、既定) と bash で、偽の `git` だけを PATH に置いて実行し、`git` が 1 回だけ文法どおりの argv で起動され他に何も起きないことを確認した (ランダム生成 3000 件)。
- 文法は意図的に狭く、正当なコマンドも pass-through (本体のデフォルトプロンプト) に落ちる。許容するトレードオフとして、次は hook の自動許可を受けない。
  - 複合コマンド・パイプ・リダイレクト・サブシェル: `git -C /a status && git -C /b diff`、`git -C /r log | head -5`、`git -C /r status 2>&1`、`git -C /r status 2>/dev/null`、`(git -C /r status)`
  - 前置: `time git -C ...`、`command git -C ...`、`GIT_PAGER=cat git -C ...`
  - word 先頭の `~` / `=`: `git -C ~/repo status`
  - `^` `#` `$` `\` `!` `*` `{}` `()` `<>` や非 ASCII・タブ・改行を含む引数 (クォート内も同じ): `git -C /r diff HEAD^`、`git -C /r commit -m "fix #12"`、`git -C /r commit -m "日本語"`、`git -C /r commit -m "feat(x): y"`、`--format='%H %s'` のようなクォートの連結
- 文法は zsh の既定の字句規則を前提にしている。ユーザ設定 (`.zshrc` 等) の global alias (`alias -g`) や `git` という名前の関数・alias は、文法に一致する入力の意味も変えうる。これはユーザ自身の設定であり hook の防御対象外とする。
- hook の allow は `-C` の対象が cwd と同じ git common dir のリポジトリに限る。別リポジトリへの `git -C` (隣の clone、`~/work/other` など) は、読み取り系でも hook の自動許可を受けず本体の確認が出る。エージェントが書き込める任意のリポジトリの `.git/config` (`core.fsmonitor`・`core.sshCommand`・`diff.external`・`protocol.ext.allow` と `ext::` remote など) や `.git/hooks` を経由した、確認無しの任意コマンド実行を防ぐためのトレードオフとして受け入れる。
- 同一リポジトリに限っても、cwd のリポジトリ自体の設定を経由した実行面は残る。これは非 -C の `git status` を本体が settings.json の allow で自動許可するのと同じ面で、`-C` 固有の問題ではない (cwd がエージェントの作ったリポジトリになっている場合も同じ)。
- 判定はファイルシステムから git の探索を再現したもので、git 本体の挙動 (`safe.directory`、`GIT_DISCOVERY_ACROSS_FILESYSTEM` が無いときのファイルシステム境界、`[include]` 経由の設定など) を完全には再現しない。再現しきれないと分かっている形は allow しない側に倒している。
- hook の保護は settings.json に `-C` 版ルールが無いことを前提にしている。ユーザが自分で `Bash(git -C * status *)` のような緩いルールを足した場合、本体がその緩いマッチで auto-approve するのを hook は止められない。
- Codex では `git -C` の自動許可が得られない (Codex 側の execpolicy の判定に委ねる)。

### Neutral

- 正規化できても非 -C allow に一致しないサブコマンド (`replace` / `submodule` 等) は ask ではなく pass-through にする。本体側に `-C` ルールが無いのでデフォルトプロンプトになり、ユーザが「次回から確認しない」で anchor されたルールを保存できる。
- 文法が外すのはシェルの構文 (リダイレクト・展開・複合コマンド等) で、git 自身のオプションによるファイル書き込み (`git -C /r log --output=/tmp/x`) や外部コマンド起動 (`git -C /r diff --ext-diff`) は外さない。非 -C の `git log --output=...` / `git diff --ext-diff` も settings.json の allow で本体が自動許可しており、`-C` 版だけ厳しくしても挙動の差が増えるだけになる。また git は長いオプションの一意な省略形 (`--out=`) を受け付けるので、オプション名の denylist では網羅できない。これらを止めるべきと判断した場合は、非 -C と合わせて settings.json の deny / ask で扱う。
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

### Option D: `-C` の対象リポジトリを制限せず、任意のディレクトリへの `git -C` を hook allow する

- 概要: 別リポジトリへの `git -C <dir> status` なども確認無しで実行させる。
- 却下理由: エージェントが `git init` して `.git/config` を書いたリポジトリを対象にすると、`core.fsmonitor` などで確認無しに任意コマンドを実行できる。

### Option E: `git rev-parse --git-common-dir` を hook から実行して同一リポジトリを判定する

- 概要: git 自身に探索させて結果を比較する。
- 却下理由: 判定のために対象リポジトリで git を実行すると、そのリポジトリの設定 (`core.fsmonitor` 以外にも読み込み時に効くもの) を hook 自身が読み込み、防ぎたい実行面を hook が踏む。ファイルシステムの読み取りだけで解決する。

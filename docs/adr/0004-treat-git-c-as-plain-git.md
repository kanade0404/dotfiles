# 4. `git -C <dir> <sub>` を `git <sub>` と同じ扱いにし、対象ディレクトリ・変数参照・複合コマンドを理由に止めない

Date: 2026-11-01

## Status

Accepted

Supersedes [3. git -C の許可判定を hook の正規化に一本化し、Claude Code でのみ hook が allow を返す](0003-normalize-git-c-in-hook.md)

ADR 0003 の決定のうち、本 ADR の Decision で変えたもの以外はそのまま引き継ぐ。

## Context

- ユーザの要望は「`git -C` は止めなくていい」である。`git -C <dir> <sub> ...` を `git <sub> ...` と同じ扱いにし、`-C` があることだけを理由に確認 (hook の ask、または Claude Code 本体の許可確認) を出さないようにしたい。正規化後の `git <sub>` に対する deny / ask (危険な git フラグ・機密パスを含む) は従来どおり効かせる。
- 実際に止まった例は次の複合コマンドである。cwd は dotfiles の worktree で、`-C` の対象は別リポジトリだった。hook は `確認が必要なコマンドが含まれています: git -C $R diff --stat` で ask を返した。

  ```text
  /usr/bin/python3 - <<'EOF'
  ...(ファイル書き換え)...
  EOF
  R=/Users/kanade0404/orca/workspaces/skills/pinniped; git -C $R diff --stat
  ```

- ADR 0003 の下では、`-C` だけを理由に確認を出す経路は 3 つあった。
  - `rule-matcher.ts` の `SHELL_EXPANSION_IN_WORD` が、`-C` の引数に `$` を含むものを一律に「正規化できない形」として ask にしていた。上の例の ask はこれである。
  - `evaluator.ts` の hook allow は `-C` の対象を限っていた (`git-repository.ts` の `isSameGitRepository`)。対象は、hook 入力の cwd と同じ git common dir を持つリポジトリだけだった。別リポジトリへの `git -C` は pass-through になる。settings.json に `-C` 版ルールが無いので、本体が確認を出す。
  - hook allow の文法 (`isPlainGitCCommand`) が単一の単純コマンドだけを許していた。複合コマンドは全セグメントが allow でも pass-through になり、同じく本体が確認を出す。
- ユーザ設定 (`.claude/settings.json` を `install.sh` で配ったもの) は `permissions.defaultMode` が `auto` である。hook は permission mode が `default` / `acceptEdits` のときしか allow を返さない (ADR 0003、`hook-response.ts` の `shouldEmitAllow`)。通常のセッションでは hook allow は出ず、上の例で確認を出していたのは hook の ask だけだった。auto mode では、hook が pass-through にすれば classifier が判定する。2 つ目と 3 つ目の経路が効くのは `default` / `acceptEdits` のセッションである。
- 複合コマンドを自動許可する方法として 2 案を比べた。
  - (a) hook が複合コマンドにも allow を返す。
  - (b) settings.json に `Bash(git -C *)` を allow として置き、本体に判定させる。hook は正規化後の deny / ask を引き続き返す (hook の deny / ask は settings の allow より優先される)。
- ADR 0003 は (b) の形を禁じていた (ADR 0003 の Option A、`README.md` の hook の節、`evaluator.ts` の `SUBCOMMAND_ANCHORED_GIT_PATTERN` のコメント)。その理由は今も有効である。
  - `Bash(git -C *)` はプレフィックス一致で、サブコマンド位置に anchor されない。本体の `Bash(git reset *)` などの deny もプレフィックス一致なので `-C` 版には効かない。
  - hook の動かない環境がある (bun 不在、`~/.claude/hooks` 未配置。hook の実行エラーは non-blocking)。そこでは本体が `git -C /x reset --hard`、`git -C /x push --force`、`git -C . submodule foreach <任意コマンド>` を確認無しに実行させる。settings.json は dotfiles として他のマシンにも配られる。
  - hook が動いていても、hook は正規化後に allow へ一致しないサブコマンド (`git -C . submodule foreach ...`、`git -C . replace ...`) を pass-through にする。(b) ではそこを本体が `Bash(git -C *)` で自動許可する。止めるには hook がそれらを ask に変える必要があり、本体のプロンプトで「次回から確認しない」を選べる UX も失う。
  - auto mode では、本体は `Bash(*)` やインタプリタのワイルドカードのような広い allow を落とすが、`Bash(git -C *)` を落とすとは限らない。残れば classifier を経ずに `git -C` の任意のサブコマンドを実行させる。
- (a) をそのまま「shell-parser で分解したセグメントが全て allow なら allow」とすると、ADR 0003 の Negative に記録した漏れをもう一度開く。漏れの例は `#` コメント + 改行、ANSI-C quoting の `\'`、パス付きコマンド名、zsh の関数定義 `name () body`、`=(...)`、`time VAR=...`、`>&1mk` である。
- evaluateCommand の allow は「deny / ask に当たらなかった」という意味で、どのルールにも一致しないセグメント (`matchCommand` が null) は読み飛ばしている。これを根拠に allow を返すとバイパスになる。
- シェルの変数展開の性質は次のとおりである。
  - クォートしない参照 (`$R`) は、値が空なら zsh でも bash でも語ごと消える。`git -C $R status rm -r .` は R が空なら `git -C status rm -r .` (ディレクトリ `status` で `git rm -r .`) として実行される。
  - bash はクォートしない参照を IFS で単語分割する。zsh は既定 (`SH_WORD_SPLIT` 無効) では分割しない。Claude Code の Bash tool はユーザの `$SHELL` (本環境では zsh) で実行する。
  - ダブルクォートした参照 (`"$R"`、`"${R}/sub"`) は値によらず 1 語のままである (空なら `-C ""` になり、git はカレントディレクトリとして扱う)。
- `git -C <dir>` は `<dir>` のリポジトリの `.git/config` と `.git/hooks` を読み込む。ADR 0003 はこれを理由に hook allow を同一リポジトリに限っていた (ADR 0003 の Option D を却下した理由)。

## Decision

- `-C` の対象ディレクトリは判定に使わない。`isSameGitRepository` とその条件を hook allow から外し、関数とテストを削除する (呼び出し元は `evaluator.ts` だけだった)。`git-repository.ts` のリポジトリ解決は、`localSettingsRootsOf` (本体が `.claude/settings.local.json` を読むルートの特定) のために残す。境界のテストは `localSettingsRootsOf` に対するものに移す。
- `-C` の引数の単純な変数参照を正規化の対象にする (`rule-matcher.ts` の `hasShellExpansionInDir`)。対象は `$NAME`、`${NAME}`、`"$NAME"`、`"${NAME}"` と、`"${NAME}/sub"` のようなダブルクォート内の参照である。
  - `$NAME` と `${NAME}` を取り除いてから `SHELL_EXPANSION_IN_WORD` を当てる。`${` は `{` (ブレース展開) より先に変数参照として消費される。取り除いた後に `$` (`${R:-x}`、`$1`、`$@`、`$(`)、バッククォート、glob (`*?[`)、ブレース展開 (`{a,b}`) が残れば従来どおり ask にする。
  - `-C` の引数がクォートしない変数参照だけの場合 (`$R`、`${R}`) は、値が空で語が消えた形 (`git -C <次の語> ...`) にも deny を照合する (`GitCAnalysis` の `vanishingDirCommand`)。ask と allow は消える前の正規化で判定する。
- 複合コマンドは (a) を採る。ただし shell-parser の分解結果は使わず、生コマンド全体に正の文法を当てる (`evaluator.ts` の `hookAllowSegments`)。次を全て満たすときだけ hook allow を返す。

    ```text
    list    := segment (SEP segment)*
    SEP     := " "* (";" | "&&" | "||" | "|") " "*
    segment := NAME "=" word?                          代入だけ
             | "git" (SP gopt)* SP "-C" SP dirword (SP gopt)* SP sub (SP word)*
             | "git" SP sub (SP word)*                 -C の無い git (global option は不可)
             | cmd (SP word)*                           git 以外の単純コマンド
    dirword := word | "\"" (plain | " " | varref)* "\"" | varref
    varref  := "$" NAME | "${" NAME "}"
    cmd     := [A-Za-z0-9_] [A-Za-z0-9_.+-]*
    word / gopt / sub / plain / SP は ADR 0003 の文法と同じ
    ```

  - 改行、末尾や途中の `&`、`|&`、ヒアドキュメント、リダイレクト、括弧、`-C` 以外の位置の展開は文法外で、pass-through にする。word の字句は区切りの文字 (`;` `&` `|`) を含まないので、文法に一致した文字列は区切りの位置でそのまま分割でき、トークナイザを通さない。
  - `git -C` のセグメントが 1 つ以上ある。`-C` の無いコマンドだけなら従来どおり本体が判定する。
  - 代入以外の全セグメントが allow ルールに肯定的に一致する。deny / ask に当たるセグメントや、どのルールにも一致しない (null) セグメントが 1 つでもあれば allow しない。
    - ask は allow と両方に当たる場合も含めて、全セグメントで照合する。`matchCommand` は `-C` の無いコマンドでは allow を ask より先に見る。その判定結果だけでは、allow と ask の両方に当たるセグメントを見落とす。例は、allow と ask の両方に `Bash(git push *)` がある状態の `git push origin main` である。`matchCommand` の順序は pass-through の UX のために変えず、`hookAllowSegments` が deny / ask のルールだけで改めて照合する。`git -C` のセグメントは正規化した形でも照合する。
    - `-C` の無い git は global option を付けない形 (`git <sub> ...`) だけを文法に入れる。allow ルールは生のセグメントで照合し、`Bash(git log *)` は `git --no-pager log` に一致しないためである。
  - 照合に使う allow は、ユーザ設定 `~/.claude/settings.json` 由来 (`readByClaudeCode`) で、次のどちらかに当たるものに限る (`rulesForHookAllow`)。deny / ask は ADR 0003 と同じく出自を問わず全て使う。
    - git のセグメントには、サブコマンドをリテラルで固定した allow (ADR 0003 と同じ `SUBCOMMAND_ANCHORED_GIT_PATTERN`) を使う。`git -C` は正規化した `git <sub> ...` で照合する。
    - git 以外のセグメントには、コマンド名をリテラルで固定した allow (`Bash(echo *)`、`Bash(pwd)`、`Bash(bun test *)`) を使う。`Bash(*)`、`Bash(e*)`、`Bash(echo*)` は使わない。
  - git 以外のコマンド名からは、シェルの予約語、zsh / bash の組み込みコマンド、別のコマンドを起動するラッパーを除く (`NON_ALLOWABLE_COMMANDS`)。`command`、`printf`、`time`、`nice`、`nohup`、`env`、`exec` などが該当する。
    - 組み込みコマンドはシェルの状態を書き換えて、後続のセグメントの意味を変えうる (`printf -v PATH ...`、`hash git=...`)。
    - ラッパーでは、allow の照合に使う先頭のコマンド名と、実際に実行されるコマンドがずれる。
    - 状態を変えない `echo`、`pwd`、`true`、`false`、`test` は許す。
  - 代入だけのセグメントで代入できるのは、同じコマンド内で `git -C` の引数として参照される変数だけである。`TFE_ADDRESS=https://evil.example; git -C . status && make plan` のように、後続のコマンドが読む変数を書き換える代入を自動許可しないためである。そのうえで、環境変数とシェルが特別扱いする変数は代入しない。
    - 環境変数は、hook の環境にあるものと、`CLAUDE_ENV_FILE` に export されているものである。`CLAUDE_ENV_FILE` は SessionStart hook が `~/.zshrc` で増えた export を書き出すファイルで、Bash tool のシェルだけが読み込む。hook の環境から読めない場合や、ファイルが無い場合は無視する。大小文字を区別せずに比べる。
    - 特別扱いする変数は `IFS`、`HOME`、zsh の `path` / `fpath` などと、`GIT_`、`LD_`、`DYLD_` で始まるものである。`PATH=/tmp/evil; git -C . status` や `HOME=/tmp/x; git -C . status` (`/tmp/x/.gitconfig` を読む) を自動許可しないためである。
    - bash でコマンドの解決や挙動を変える `EXECIGNORE`、`FIGNORE`、`HOSTFILE`、`BASH_COMPAT` も特別扱いする変数に含める。代入しても値の入らない bash の `FUNCNAME` と、zsh の `funcstack`、`functrace`、`funcfiletrace`、`funcsourcetrace` も含める。
  - `-C` の引数がクォートしない変数参照 (`$R`) のときは、同じコマンド内での R の代入を条件にする (`isSafelyAssignedBefore`)。
    - 参照より前に、必ず実行される位置の R の代入がある。必ず実行される位置とは、先頭からその代入までの区切りが全て `;` で、代入の直後の区切りが `|` でないことを指す。
    - コマンド内の R の代入は、全て値が空でなく空白を含まない。
    - `false && R=/x; git -C $R status`、`R=/x | git -C $R status`、`R=/x; R=; git -C $R status`、`R='/x y'; git -C $R status` は自動許可しない。代入の無い `git -C $R diff` も自動許可しない (pass-through)。
    - ダブルクォートした `"$R"` は値によらず 1 語なので、この条件を課さない。
  - クォートしない `$R` では、さらに 2 つの解釈がどちらも allow ルールに肯定的に一致し、どちらも deny / ask に当たらないことを求める。1 つは値が入った解釈 (正規化した `git <sub> ...`) で、もう 1 つは語が消えた解釈 (`git -C <次の語> ...`。`-C` が次の語を取るので、正規化すると `git <その次> ...` になる) である。代入しても値の入らない変数や、列挙から漏れた特殊な変数で語が消える場合を考える。そのときも、実行される内容を allow の範囲に収めるためである。
    - `R=/x; git -C $R --no-pager log` は自動許可する。語の消えた形は `git -C --no-pager log` で、正規化すると `git log` になる。
    - `R=/x; git -C $R diff --stat` は自動許可しない。語の消えた形 `git -C diff --stat` は allow に一致しない。
    - `R=/x; git -C $R diff push origin main` も自動許可しない。語の消えた形は `git push origin main` で、ask に当たる。
- ADR 0003 の決定のうち、上で変えたもの以外は維持する。
  - settings.json には `git -C` 系の permission ルールを置かない (テストで固定している)。
  - 正規化後の照合順 (非 -C の deny → 危険 git フラグの backstop → 機密パス → 非 -C の ask → 非 -C の allow)。
  - `--client=claude-code` で起動されたときだけ allow を返し、Codex には allow を返さない。
  - permission mode が `default` / `acceptEdits` のときだけ allow を返す。
  - hook allow の根拠をユーザ設定の allow に限る。
  - 本体の読む deny / ask を hook で読み切れない構成では、hook allow しない。`CLAUDE_PROJECT_DIR` が無い、`CLAUDE_CONFIG_DIR` がある、managed settings を解釈できない、などの構成である。
- Codex から起動されたときは、`-C` の引数の変数参照で ask を返していたものが pass-through (無出力) になる。deny は従来どおり返す。

## Consequences

### Positive

- 上の例の `git -C $R diff --stat` は ask にならない。auto mode のセッションでは pass-through になり classifier が判定する。`default` / `acceptEdits` のセッションでは、`R=...; git -C "$R" diff --stat` とクォートすれば hook が自動許可する。クォートしない `R=...; git -C $R diff --stat` は、語が消えた形 (`git -C diff --stat`) が allow に一致しないので pass-through になる。
- `default` / `acceptEdits` のセッションでは、別リポジトリへの `git -C` が確認無しに通る。`git -C /a status && git -C /b diff` や `git -C /r log | head -5` のような複合コマンドも同様である。
- `git -C $R push --force`、`git -C /other reset --hard`、`R=/x; git -C $R push --force` は従来どおり deny になる。
- ask ルールに当たるセグメントを含む複合コマンドは hook allow しない。`git -C` のセグメントは正規化後の形で、`-C` の無いセグメントと git 以外のセグメントは生の形で照合する。allow と ask の両方に当たるセグメントも同じである。たとえば allow と ask の両方に `Bash(git push *)` があるとき、`git -C /r status && git push origin main` は hook allow せず、本体の判定に委ねる。正規化後の ask は、`git -C` のセグメントについては evaluateCommand の判定でも ask になる。
- hook allow の判定から、ファイルシステムで git の探索を再現する処理 (`isSameGitRepository`) が無くなる。

### Negative

- 受け入れたトレードオフの 1 つ目は、別リポジトリの `.git/config` と `.git/hooks` が確認無しに実行されうることである。
  - `.git/config` では `core.fsmonitor`、`diff.external`、`core.sshCommand`、`core.hooksPath` などが外部コマンドを起動する。
  - エージェントは一時ディレクトリに `git init` して `.git/config` を書き、`git -C <dir> status` で任意のコマンドを実行させられる。`acceptEdits` では、ファイルの書き込み自体も確認無しで通りうる。
  - ADR 0003 が Option D として却下した形を、ユーザの要望で受け入れる。cwd のリポジトリ自体の設定を経由した実行面は、ADR 0003 の時点でも非 -C の `git status` と同じく残っていた。
- 受け入れたトレードオフの 2 つ目は、bash ではクォートしない `$VAR` が単語分割されることである。
  - hook は `-C $R` を 1 語として正規化する。R に空白を含む値が入っていると、実際に実行されるサブコマンドと hook が照合したサブコマンドがずれる。`R='/x reset --hard'` なら、`git -C $R status` は bash で `git -C /x reset --hard status` になる。
  - hook allow は、クォートしない参照に同じコマンド内の空白を含まない代入を求める。そのため、この場合は自動許可しない。
  - ただし deny / ask の照合も 1 語として行う。環境から来た値や bash 以外での分割 (zsh の `SH_WORD_SPLIT`) では、危険 git フラグの backstop や deny が効かないまま pass-through になりうる。以前は `-C` の引数に `$` があれば一律に ask だった。
  - pass-through 後は、`default` では本体が確認を出し、auto mode では classifier が判定する (settings.json に `-C` ルールが無いので本体は自動許可しない)。`bypassPermissions` では実行される。
  - 値が空で語が消える形は、evaluateCommand の判定では deny だけ追加で照合し、ask は照合しない。`ask: ["Bash(git push *)"]` があっても、`git -C $EMPTY status push` は EMPTY が空なら `git -C status push` として実行される。hook はこれを ask とせず pass-through する。hook allow の判定では、語が消えた形にも allow への一致と、deny / ask に当たらないことを求める。
- 複合コマンドの hook allow は、本体が自分でセグメントを解析して判定する手順を飛ばす。git 以外のセグメントは、ユーザ設定のコマンド名を固定した allow に一致することを根拠にする。`default` / `acceptEdits` の本体も同じ allow で自動許可するが、本体がそれ以外に行う検査 (作業ディレクトリ外のパスなど) と一致する保証は無い。
- 複合コマンドの文法は、ADR 0003 の単一コマンドの文法と違い、文法に一致する入力を zsh と bash で実際に実行する検証 (偽の `git` を PATH に置いたランダム生成の実行) をしていない。根拠はシェルの字句規則の検討と、hook をプロセスとして起動するテストだけである。
- 別リポジトリの `.git/config` と `.git/hooks` は `git clone` でコピーされない。それでも、確認無しに実行される設定が入りうる経路は 3 つある。
  - 1 つ目は、エージェントが自分で書いたリポジトリである。`safe.bareRepository` では塞げず、トレードオフとして残る。
  - 2 つ目は、clone した作業ツリーに埋め込まれた bare リポジトリ (embedded bare repository) である。`nix/home.nix` の `programs.git.settings` で `safe.bareRepository = "explicit"` を指定して塞いだ。この設定の下では、`--git-dir` などで明示しない限り git は bare リポジトリを暗黙に開かない。`git -C` や `cd` でその config が読まれることはない。ただしこの設定は home-manager (`nix/home.nix`) を適用したホストにしか効かない。`install.sh` で hook と settings.json だけを配ったマシンでは、この経路は開いたままである。hook の側には、git の設定を確かめる仕組みは無い。
  - 3 つ目は、アーカイブを展開したディレクトリである。`tar x`、`unzip`、`gh release download` などで展開したディレクトリには、`.git/` (`core.fsmonitor` を書いた `.git/config` など) がそのまま入りうる。`git -C <展開先> status` は確認無しに hook allow され、fsmonitor が起動する。これは bare リポジトリではないので、`safe.bareRepository` では塞げない。トレードオフとして残る。
- `safe.bareRepository = "explicit"` は、bare リポジトリを暗黙に開く既存の運用に影響する。git 2.54.0 で `GIT_CONFIG_*` を使って設定を再現し、次のことを確かめた。
  - bare clone のディレクトリの中で直接 git を実行すると、`fatal: cannot use bare repository ... (safe.bareRepository is 'explicit')` で止まる。bare の中で `git worktree add` を実行した場合も同じである。bare clone と worktree を組み合わせる運用では、worktree の作成・一覧・削除や bare 側での fetch に `--git-dir=<bare>` の指定が要る。
  - `git --git-dir=<bare> worktree add` で作った worktree の中では、status、log、fetch が普段どおり動く。
  - nix 2.34.9 の `builtins.fetchGit` と `nix flake metadata --refresh` は影響を受けない。
  - Go は検証していない。VCS キャッシュ (`$GOMODCACHE/cache/vcs`) は bare リポジトリなので、`GOPROXY=direct` での git 取得は壊れる可能性がある。cargo も `net.git-fetch-with-cli=true` にすると同じ可能性がある。既定の libgit2 を使う場合は影響しない。
  - 該当するディレクトリだけは、`includeIf "gitdir:<dir>/"` で `safe.bareRepository = all` にして回避する。
- 組み込みコマンド・ラッパーの除外 (`NON_ALLOWABLE_COMMANDS`) と特別扱いする変数 (`SPECIAL_VARIABLES`) は列挙であり、網羅を保証しない。代入できる変数は `git -C` の引数として参照されるものに限るので、代入の値が届くのは `-C` の引数と、その変数を読むシェル自身の挙動だけである。export 済みかどうかは、hook の環境変数と `CLAUDE_ENV_FILE` で近似している。hook の環境から `CLAUDE_ENV_FILE` を読めない構成では、Bash tool のシェルスナップショットだけで export された変数への代入を自動許可しうる。ユーザ設定の alias・関数・global alias が文法に一致する入力の意味を変えうる点は ADR 0003 と同じく防御対象外とする。
- クォートしない `-C $R` は、ほとんどの場合 `default` / `acceptEdits` でも本体の確認が出る。代入を伴わない場合 (`git -C $R diff`) と、語の消えた形が allow に一致しない場合 (`R=/x; git -C $R diff --stat`) である。自動許可したい場合は `git -C "$R" diff` とクォートする。
- 上の例そのもの (ヒアドキュメント付きの `/usr/bin/python3` を含む) は文法外なので hook allow しない。python3 はユーザ設定の allow にも無いので、`default` では本体が確認を出す。

### Neutral

- hook が動かない環境では、ADR 0003 と同じく `git -C` は本体のデフォルトプロンプトになる (settings.json に `-C` ルールを置かない (b) を採らなかったため)。
- 複合コマンドの文法と各セグメントの条件は、ADR 0003 の「どのシェルでも単純コマンドとしか読めない字句だけを正の文法で許す」原則を保つ。shell-parser / rule-matcher のトークナイザは許可判定に使わない (deny / ask の判定には従来どおり使う)。

## Alternatives Considered

### Option A: settings.json に `Bash(git -C *)` の allow を置き、本体に判定させる ((b))

- 概要: hook は正規化後の deny / ask だけを返し、allow は本体のプレフィックス一致に任せる。
- 却下理由: Context に書いたとおり、hook が動かない環境で `-C` 版の deny がすべて外れ、hook が pass-through にする未知のサブコマンドも本体が自動許可する。auto mode でも classifier を経ずに通りうる。ADR 0003 が Option A を却下した理由がそのまま当てはまる。

### Option B: shell-parser で分解したセグメントが全て allow なら hook allow する

- 概要: evaluateCommand のセグメント単位の判定をそのまま hook allow の根拠にする。
- 却下理由: ADR 0003 の経緯のとおり、部分的なシェルのモデルで危険な形を除外する方式は漏れが続いた。どのルールにも一致しないセグメントを読み飛ばしている現在の allow を根拠にすると、未知のコマンドを含む複合コマンドまで自動許可する。

### Option C: 同一リポジトリの制限を残し、変数参照の ask だけを外す

- 概要: 1 つ目の経路だけを直す。
- 却下理由: ユーザの要望は別リポジトリへの `git -C` も止めないことである。上の例も別リポジトリが対象だった。

### Option D: クォートしない `$R` を、同じコマンド内の代入を条件にせず hook allow する

- 概要: `-C $R` を常に 1 語として扱う。
- 却下理由: R が空のとき `git -C $R status rm -r .` は `git -C status rm -r .` として実行され、hook が照合した `git status rm -r .` (allow) と実行内容がずれる。zsh でも起きるので、bash だけのトレードオフとしては受け入れられない。

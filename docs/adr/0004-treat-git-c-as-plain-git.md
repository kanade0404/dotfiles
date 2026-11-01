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
             | "git" (SP gopt)* SP sub (SP word)*      -C の無い git
             | cmd (SP word)*                           git 以外の単純コマンド
    dirword := word | "\"" (plain | " " | varref)* "\"" | varref
    varref  := "$" NAME | "${" NAME "}"
    cmd     := [A-Za-z0-9_] [A-Za-z0-9_.+-]*
    word / gopt / sub / plain / SP は ADR 0003 の文法と同じ
    ```

  - 改行、末尾や途中の `&`、`|&`、ヒアドキュメント、リダイレクト、括弧、`-C` 以外の位置の展開は文法外で、pass-through にする。word の字句は区切りの文字 (`;` `&` `|`) を含まないので、文法に一致した文字列は区切りの位置でそのまま分割でき、トークナイザを通さない。
  - `git -C` のセグメントが 1 つ以上ある。`-C` の無いコマンドだけなら従来どおり本体が判定する。
  - 代入以外の全セグメントが allow ルールに肯定的に一致する。deny / ask に当たるセグメントや、どのルールにも一致しない (null) セグメントが 1 つでもあれば allow しない。
  - 照合に使う allow は、ユーザ設定 `~/.claude/settings.json` 由来 (`readByClaudeCode`) で、次のどちらかに当たるものに限る (`rulesForHookAllow`)。deny / ask は ADR 0003 と同じく出自を問わず全て使う。
    - git のセグメントには、サブコマンドをリテラルで固定した allow (ADR 0003 と同じ `SUBCOMMAND_ANCHORED_GIT_PATTERN`) を使う。`git -C` は正規化した `git <sub> ...` で照合する。
    - git 以外のセグメントには、コマンド名をリテラルで固定した allow (`Bash(echo *)`、`Bash(pwd)`、`Bash(bun test *)`) を使う。`Bash(*)`、`Bash(e*)`、`Bash(echo*)` は使わない。
  - git 以外のコマンド名からは、シェルの予約語、zsh / bash の組み込みコマンド、別のコマンドを起動するラッパーを除く (`NON_ALLOWABLE_COMMANDS`)。`command`、`printf`、`time`、`nice`、`nohup`、`env`、`exec` などが該当する。
    - 組み込みコマンドはシェルの状態を書き換えて、後続のセグメントの意味を変えうる (`printf -v PATH ...`、`hash git=...`)。
    - ラッパーでは、allow の照合に使う先頭のコマンド名と、実際に実行されるコマンドがずれる。
    - 状態を変えない `echo`、`pwd`、`true`、`false`、`test` は許す。
  - 代入だけのセグメントでは、環境変数とシェルが特別扱いする変数を代入しない。環境変数は hook の環境にあるもので、大小文字を区別せずに比べる。特別扱いする変数は `IFS`、`HOME`、zsh の `path` / `fpath` などと、`GIT_`、`LD_`、`DYLD_` で始まるものである。`PATH=/tmp/evil; git -C . status` や `HOME=/tmp/x; git -C . status` (`/tmp/x/.gitconfig` を読む) を自動許可しないためである。
  - `-C` の引数がクォートしない変数参照 (`$R`) のときは、同じコマンド内での R の代入を条件にする (`isSafelyAssignedBefore`)。
    - 参照より前に、必ず実行される位置の R の代入がある。必ず実行される位置とは、先頭からその代入までの区切りが全て `;` で、代入の直後の区切りが `|` でないことを指す。
    - コマンド内の R の代入は、全て値が空でなく空白を含まない。
    - `false && R=/x; git -C $R status`、`R=/x | git -C $R status`、`R=/x; R=; git -C $R status`、`R='/x y'; git -C $R status` は自動許可しない。代入の無い `git -C $R diff` も自動許可しない (pass-through)。
    - ダブルクォートした `"$R"` は値によらず 1 語なので、この条件を課さない。
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

- 上の例の `git -C $R diff --stat` は ask にならない。auto mode のセッションでは pass-through になり classifier が判定する。`default` / `acceptEdits` のセッションでは `R=...; git -C $R diff --stat` を hook が自動許可する。
- `default` / `acceptEdits` のセッションでは、別リポジトリへの `git -C` が確認無しに通る。`git -C /a status && git -C /b diff` や `git -C /r log | head -5` のような複合コマンドも同様である。
- `git -C $R push --force`、`git -C /other reset --hard`、`R=/x; git -C $R push --force` は従来どおり deny になる。正規化後の ask (`ask: ["Bash(git push *)"]` など) は複合コマンドの中でも ask になる。
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
  - 値が空で語が消える形は deny だけ追加で照合し、ask は照合しない。`ask: ["Bash(git push *)"]` があっても、`git -C $EMPTY status push` は EMPTY が空なら `git -C status push` として実行される。hook はこれを ask とせず pass-through する。
- 複合コマンドの hook allow は、本体が自分でセグメントを解析して判定する手順を飛ばす。git 以外のセグメントは、ユーザ設定のコマンド名を固定した allow に一致することを根拠にする。`default` / `acceptEdits` の本体も同じ allow で自動許可するが、本体がそれ以外に行う検査 (作業ディレクトリ外のパスなど) と一致する保証は無い。
- 複合コマンドの文法は、ADR 0003 の単一コマンドの文法と違い、文法に一致する入力を zsh と bash で実際に実行する検証 (偽の `git` を PATH に置いたランダム生成の実行) をしていない。根拠はシェルの字句規則の検討と、hook をプロセスとして起動するテストだけである。
- 別リポジトリの `.git/config` と `.git/hooks` は `git clone` でコピーされない。そのため、確認無しに実行される設定が入りうる経路は 2 つに絞られる。1 つはエージェントが自分で書いたリポジトリ、もう 1 つは clone した作業ツリーに埋め込まれた bare リポジトリ (embedded bare repository) である。後者は `nix/home.nix` の `programs.git.settings` で `safe.bareRepository = "explicit"` を指定して塞いだ。この設定の下では、`--git-dir` などで明示しない限り git は bare リポジトリを暗黙に開かない。`git -C` や `cd` でその config が読まれることはない。前者はこの設定では塞げず、トレードオフとして残る。
- 組み込みコマンド・ラッパーの除外 (`NON_ALLOWABLE_COMMANDS`) と特別扱いする変数 (`SPECIAL_VARIABLES`) は列挙であり、網羅を保証しない。代入してよい変数の判定は hook の環境変数で近似している。Bash tool のシェルスナップショットが hook の環境に無い変数を export している場合、その変数への代入は自動許可されうる。ユーザ設定の alias・関数・global alias が文法に一致する入力の意味を変えうる点は ADR 0003 と同じく防御対象外とする。
- `git -C $R diff` のように代入を伴わないクォートしない参照は、`default` / `acceptEdits` でも本体の確認が出る。自動許可したい場合は `git -C "$R" diff` と書くか、同じコマンド内で代入する。
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

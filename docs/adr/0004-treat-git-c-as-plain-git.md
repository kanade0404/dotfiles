# 4. `git -C <dir> <sub>` を `git <sub>` と同じ扱いにし、対象ディレクトリ・クォートした変数参照・複合コマンドを理由に止めない

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
- シェルの変数展開の性質は次のとおりである。zsh の挙動は zsh 5.9 で `zsh -f -c` を実行して確かめた。
  - クォートしない参照 (`$R`) は、値が空なら zsh でも bash でも語ごと消える。`git -C $R status rm -r .` は R が空なら `git -C status rm -r .` (ディレクトリ `status` で `git rm -r .`) として実行される。
  - bash はクォートしない参照を IFS で単語分割する。zsh は既定 (`SH_WORD_SPLIT` 無効) ではスカラーを分割しないが、配列の参照は要素ごとに別の語になる。`a=(x push --force); git -C $a status` は zsh で `git -C x push --force status` として実行される。
  - zsh の修飾子は値を変える。`R=/x` のとき `$R:e` (拡張子) は空になり、語ごと消える。添字 (`$R[1]`) も同様に値を変える。
  - ダブルクォートした参照 (`"$R"`、`"${R}"`) は値によらず 1 語のままである。zsh の配列でも、`"$a"` は要素を空白で繋いだ 1 語になる。空なら `-C ""` になり、git はカレントディレクトリとして扱う。
  - Claude Code の Bash tool はユーザの `$SHELL` (本環境では zsh) で実行する。
- `git -C <dir>` は `<dir>` のリポジトリの `.git/config` と `.git/hooks` を読み込む。ADR 0003 はこれを理由に hook allow を同一リポジトリに限っていた (ADR 0003 の Option D を却下した理由)。
- 一度は、代入 (`R=/x; git -C $R ...`) とクォートしない `$R` も hook allow の対象にした。そのために、代入の位置と値の条件、代入できる変数名の制限、特殊な変数の列挙、`CLAUDE_ENV_FILE` の読み込み、語が消えた形の allow 照合を足した。しかしレビューのたびに新しい抜け道が見つかり、収束しなかった。見つかった抜け道は、zsh の配列と修飾子、代入しても値の入らない変数、PreToolUse hook には渡らない `CLAUDE_ENV_FILE` などである。またユーザは auto mode で使っており、hook allow の経路 (`default` / `acceptEdits` でだけ効く) は普段使われない。ユーザの本来の要望は「`-C $R` を理由に hook が ask しない」ことで、これは deny / ask の判定の側で扱う。ただし Decision のとおり、満たすのはダブルクォートした `"$R"` の場合だけである。クォートしない `$R` は展開後の語数を静的に決められないので引き続き ask になり、上の例もそのままでは ask のままである。

## Decision

- `-C` の対象ディレクトリは判定に使わない。`isSameGitRepository` とその条件を hook allow から外し、関数とテストを削除する (呼び出し元は `evaluator.ts` だけだった)。`git-repository.ts` のリポジトリ解決は、`localSettingsRootsOf` (本体が `.claude/settings.local.json` を読むルートの特定) のために残す。境界のテストは `localSettingsRootsOf` に対するものに移す。
- `-C` の引数の変数参照の扱いを次のように決める (`rule-matcher.ts` の `EXACT_VARIABLE_DIR`)。
  - ダブルクォートした `"$NAME"` / `"${NAME}"` は、値がどうであれ 1 語のままである。そのため、リテラルの dir と同じく正規化する。対象は、語全体がちょうどこの形で前後に何も付かないものだけである。正規化した `git <sub> ...` で deny / ask / allow を照合し、`-C` があることだけを理由とした ask は出さない。
  - クォートしない `$NAME` / `${NAME}` は、正規化した形 (`git <sub> ...`) と、値が空で語が消えた形 (`git -C <次の語> ...`) の両方で deny を照合したうえで、ask にする。代入の有無や名前、サブコマンドの有無 (`git -C $a`) にもよらない。`git -C $R push --force` は deny になり、`git -C $R diff --stat` や `R=/x; git -C $R diff --stat` は ask になる。外の環境の変数を使うときも、同じコマンドで代入した変数を使うときも、`git -C "$R" diff --stat` とクォートすれば ask にならない。
  - それ以外の形も従来どおり ask にする。zsh の修飾子 (`$R:e`、`$R:t`)、添字 (`$R[1]`)、連結 (`$R/sub`、`"${R}/sub"`)、既定値付き (`${R:-x}`)、特殊パラメータ (`$1`、`$@`) などが該当する。
  - クォートしない参照を ask にする理由は、展開後の語数を静的に決められないことである。bash は値を IFS で単語分割し、zsh は配列の参照を要素ごとに別の語にする。値が空なら語ごと消える。同じコマンドの中には、配列を作る構文 (`typeset -T`、`zstyle -a`、`${(A)name::=...}`、`set --`、tied 配列) を書ける。名前を組み立てる展開 (`R''R`、`AB{C,}`、glob) も、語分割を変える設定 (`IFS`、`setopt shwordsplit`、`printf -vIFS`) も書ける。条件付きで正規化する規則を 3 回作り直したが、そのたびにレビューで新しい抜け道が見つかり、収束しなかった (Option D)。
- 複合コマンドは (a) を採る。ただし shell-parser の分解結果は使わず、生コマンド全体に正の文法を当てる (`evaluator.ts` の `hookAllowSegments`)。次を全て満たすときだけ hook allow を返す。

    ```text
    list    := segment (SEP segment)*
    SEP     := " "* (";" | "&&" | "||" | "|") " "*
    segment := "git" (SP gopt)* SP "-C" SP dirword (SP gopt)* SP sub (SP word)*
             | "git" SP sub (SP word)*                 -C の無い git (global option は不可)
             | cmd (SP word)*                           git 以外の単純コマンド
    dirword := word | "\"" varref "\""
    varref  := "$" NAME | "${" NAME "}"
    cmd     := [A-Za-z0-9_] [A-Za-z0-9_.+-]*
    word / gopt / sub / SP は ADR 0003 の文法と同じ
    ```

  - hook allow の対象は、リテラルの dir と `"$VAR"` / `"${VAR}"` の `git -C` と、`-C` の無い git と allow に当たる git 以外の単純コマンドを繋いだ複合コマンドである。
  - 代入 (`R=/x`) とクォートしない変数参照 (`-C $R`) は対象外にする。理由は 2 つある。1 つは、zsh の配列と修飾子があるため、クォートしない語の展開は静的に決められないことである。もう 1 つは、代入が export 済みの変数を書き換え、後のセグメントや git 自身の動作を変えうることである。hook からは、Bash tool のシェルだけが読み込む export (SessionStart hook が `CLAUDE_ENV_FILE` に書き出すもの) を確かめられない。
  - 改行、末尾や途中の `&`、`|&`、ヒアドキュメント、リダイレクト、括弧、`-C` 以外の位置の展開も文法外で、pass-through にする。word の字句は区切りの文字 (`;` `&` `|`) を含まないので、文法に一致した文字列は区切りの位置でそのまま分割でき、トークナイザを通さない。
  - `git -C` のセグメントが 1 つ以上ある。`-C` の無いコマンドだけなら従来どおり本体が判定する。
  - 全セグメントが allow ルールに肯定的に一致し、deny / ask に当たらない。どのルールにも一致しない (null) セグメントが 1 つでもあれば allow しない。
    - `git -C` のセグメントは、`matchCommand` が正規化した `git <sub> ...` で deny > ask > allow の順に照合する。deny と機密パスの照合はクォートの中を消してから行うので、空白も `$` も含まない語はクォートを外した形でも照合する (`head '.env'` を見落とさないため)。
    - `-C` の無いセグメントと git 以外のセグメントでは、`matchCommand` は allow を ask より先に見る。その結果だけでは、allow と ask の両方に当たるセグメントを見落とす。例は、allow と ask の両方に `Bash(git push *)` がある状態の `git push origin main` である。`matchCommand` の順序は pass-through の UX のために変えず、`hookAllowSegments` が deny / ask のルールだけで改めて照合する。
    - `-C` の無い git は global option を付けない形 (`git <sub> ...`) だけを文法に入れる。allow ルールは生のセグメントで照合し、`Bash(git log *)` は `git --no-pager log` に一致しないためである。
  - 照合に使う allow は、ユーザ設定 `~/.claude/settings.json` 由来 (`readByClaudeCode`) で、次のどちらかに当たるものに限る (`rulesForHookAllow`)。deny / ask は ADR 0003 と同じく出自を問わず全て使う。
    - git のセグメントには、サブコマンドをリテラルで固定した allow (ADR 0003 と同じ `SUBCOMMAND_ANCHORED_GIT_PATTERN`) を使う。`git -C` は正規化した `git <sub> ...` で照合する。
    - git 以外のセグメントには、コマンド名をリテラルで固定した allow (`Bash(echo *)`、`Bash(pwd)`、`Bash(bun test *)`) を使う。`Bash(*)`、`Bash(e*)`、`Bash(echo*)` は使わない。
  - git 以外のコマンド名からは、シェルの予約語、zsh / bash の組み込みコマンド、別のコマンドを起動するラッパーを除く (`NON_ALLOWABLE_COMMANDS`)。`command`、`printf`、`time`、`nice`、`nohup`、`env`、`exec` などが該当する。状態を変えない `echo`、`pwd`、`true`、`false`、`test` は含めない。
    - 組み込みコマンドはシェルの状態を書き換えて、後続のセグメントの意味を変えうる (`printf -v PATH ...`、`hash git=...`)。
    - ラッパーでは、allow の照合に使う先頭のコマンド名と、実際に実行されるコマンドがずれる。
- ADR 0003 の決定のうち、上で変えたもの以外は維持する。
  - settings.json には `git -C` 系の permission ルールを置かない (テストで固定している)。
  - 正規化後の照合順 (非 -C の deny → 危険 git フラグの backstop → 機密パス → 非 -C の ask → 非 -C の allow)。
  - `--client=claude-code` で起動されたときだけ allow を返し、Codex には allow を返さない。
  - permission mode が `default` / `acceptEdits` のときだけ allow を返す。
  - hook allow の根拠をユーザ設定の allow に限る。
  - 本体の読む deny / ask を hook で読み切れない構成では、hook allow しない。`CLAUDE_PROJECT_DIR` が無い、`CLAUDE_CONFIG_DIR` がある、managed settings を解釈できない、などの構成である。
- Codex から起動されたときも、変数参照の扱いは同じである。ダブルクォートした `"$R"` は、他の deny / ask に当たらなければ pass-through (無出力) になる。クォートしない `$R` / `${R}` は、deny を照合したうえで ask を出力する。deny は従来どおり返す。

## Consequences

### Positive

- 上の例は、`git -C "$R" diff --stat` とクォートすれば ask にならない。クォートしない `$R` のままでは、引き続き ask になる。`R=...; git -C "$R" diff --stat` は代入を含むので hook allow はせず、pass-through になる。auto mode のセッションでは classifier が判定し、`default` / `acceptEdits` のセッションでは本体が確認を出す。代入を含めなければ、`default` / `acceptEdits` でも hook が自動許可する。
- `default` / `acceptEdits` のセッションでは、別リポジトリへの `git -C` が確認無しに通る。`git -C /a status && git -C /b diff` や `git -C /r log | head -5` のような複合コマンドも同様である。
- `git -C $R push --force`、`git -C /other reset --hard`、`R=/x; git -C $R push --force` は従来どおり deny になる。
- ask ルールに当たるセグメントを含む複合コマンドは hook allow しない。allow と ask の両方に当たるセグメントも同じである。たとえば allow と ask の両方に `Bash(git push *)` があるとき、`git -C /r status && git push origin main` は hook allow せず、本体の判定に委ねる。
- hook allow の条件は、文法と allow / deny / ask の照合だけになる。代入の位置や値、変数名の列挙、環境変数の読み取りのように、シェルの状態を hook の側で推測する処理は持たない。hook allow の判定から、ファイルシステムで git の探索を再現する処理 (`isSameGitRepository`) も無くなる。

### Negative

- 受け入れたトレードオフの 1 つ目は、別リポジトリの `.git/config` と `.git/hooks` が確認無しに実行されうることである。
  - `.git/config` では `core.fsmonitor`、`diff.external`、`core.sshCommand`、`core.hooksPath` などが外部コマンドを起動する。
  - エージェントは一時ディレクトリに `git init` して `.git/config` を書き、`git -C <dir> status` で任意のコマンドを実行させられる。`acceptEdits` では、ファイルの書き込み自体も確認無しで通りうる。
  - ADR 0003 が Option D として却下した形を、ユーザの要望で受け入れる。cwd のリポジトリ自体の設定を経由した実行面は、ADR 0003 の時点でも非 -C の `git status` と同じく残っていた。
- クォートしない `-C $R` は、代入の有無を問わず ask になる。同じコマンドの中でリテラルを代入した場合 (`R=/x; git -C $R diff --stat`) も確認が出る。ask を避けるには `"$R"` とクォートする必要がある。
  - deny は、正規化した形と語が消えた形の両方で照合する。それ以外の語数 (bash の単語分割、zsh の配列) の場合は deny を照合しきれないが、ask になるので確認無しには実行されない。`bypassPermissions` では実行される。
- 代入を含むコマンドは、`default` / `acceptEdits` では本体の確認が出る。自動許可したい場合は、代入を分けて `git -C "$R" diff` とクォートする。
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
- 組み込みコマンド・ラッパーの除外 (`NON_ALLOWABLE_COMMANDS`) は列挙であり、網羅を保証しない。ユーザ設定の alias・関数・global alias が文法に一致する入力の意味を変えうる点は ADR 0003 と同じく防御対象外とする。
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

### Option D: クォートしない `$R` を、条件を付けて正規化・hook allow する

- 概要: 同じコマンド内の代入を条件に、`R=/x; git -C $R diff --stat` も hook allow する。代入の位置と値、代入できる変数名、特殊な変数の列挙、`CLAUDE_ENV_FILE` の export、語が消えた形の allow 照合を条件にする。
- 却下理由: Context に書いたとおり、条件を足すたびに新しい抜け道が見つかり収束しなかった。zsh の配列と修飾子は値を見ないと語数が決まらない。代入しても値の入らない変数もある。`CLAUDE_ENV_FILE` は PreToolUse hook に渡らないので、Bash tool のシェルだけが export する変数を hook から確かめられない。この経路はユーザが普段使う auto mode では効かず、得るものも小さい。
- その後、hook allow ではなく、正規化 (ask にしないこと) の条件だけを決める規則も試した。配列を作る構文の列挙、続いて閉じた文法 (閉じた字句・大文字の名前・同じコマンド内でのリテラルの代入・`$` の位置・禁止語) である。どちらも次のレビューで抜け道が見つかった (`set -A ? ...` の glob、`printf -vIFS` による bash の語分割など)。クォートしない参照の語数はシェルの状態で変わり、文字列だけでは決められない。そこで条件付きの正規化はやめ、一律で ask にした。

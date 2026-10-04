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
- hook の `loadRules` は Codex と Claude Code の設定をマージするため、`~/.codex/settings.json`、hook 入力の `cwd` 基準の `.codex/settings.json` / `.codex/settings.local.json` / `.claude/settings.json` / `.claude/settings.local.json` も読む。リポジトリの内容 (clone 元が仕込める / エージェントが書ける) である `.codex/settings.json` やサブディレクトリの `.claude/settings.json` に allow を置くだけで、本体は読まないのに hook が allow を返せていた (PR #272 のレビュー r4176486762: `.codex/settings.json` に `Bash(git submodule *)` を置くと `git -C . submodule foreach touch pwned` を hook allow)。
- Claude Code 本体が permission ルールを読む設定は次のとおり (2026-10 時点のドキュメント)。
  - ユーザ設定 `~/.claude/settings.json`。`CLAUDE_CONFIG_DIR` があれば設定・履歴・プラグインをそこに置く (<https://code.claude.com/docs/en/settings#find-or-create-your-settings-files>)。
  - 共有プロジェクト設定 `.claude/settings.json` はセッションの primary working directory (開始ディレクトリ、`/cd` 後は移動先) から読み、親ディレクトリは探さない (<https://code.claude.com/docs/en/permissions#additional-directories-grant-file-access-not-configuration>)。
  - ローカル設定 `.claude/settings.local.json` は v2.1.211 以降、git リポジトリのルートから読む。worktree では main checkout のルート。git 管理外・リポジトリルートがホームディレクトリ・Windows・所有者が異なる場合は `.claude/settings.json` と同じ開始ディレクトリ。以前のバージョンが開始ディレクトリに残したファイルも併せて読む (<https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository>、<https://code.claude.com/docs/en/permissions#permission-system>)。
  - managed settings: macOS は `/Library/Application Support/ClaudeCode/`、Linux / WSL は `/etc/claude-code/`、Windows は `C:\Program Files\ClaudeCode\` の `managed-settings.json` と `managed-settings.d/*.json` (隠しファイル以外を名前順にマージ、リストは結合)。ほかに macOS の MDM 構成プロファイル (`com.anthropic.claudecode` の managed preferences)、Windows のレジストリ (HKLM / HKCU)、claude.ai のサーバー管理設定 (キャッシュは `~/.claude/remote-settings.json`)、埋め込みホストが SDK で渡す parent settings がある。managed settings が `allowManagedPermissionRulesOnly` を設定すると、本体は managed 以外の allow を使わない。読めない・JSON でない managed settings ファイルがあると本体は起動を拒否する (<https://code.claude.com/docs/en/managed-settings>、<https://code.claude.com/docs/en/server-managed-settings>)。
  - コマンドラインの `--settings` (<https://code.claude.com/docs/en/settings#change-a-setting-for-one-session>)。
- hook が allow を返すと本体の deny / ask はプレフィックス一致のため `-C` 版に効かない。hook が読まない設定の deny / ask は、hook allow で黙って迂回される。PR #272 のレビューで、`CLAUDE_CONFIG_DIR=$S/cfg` の `$S/cfg/settings.json` に `ask: ["Bash(git push *)"]`・`deny: ["Bash(git log *)"]` を置いても `git -C . push` / `git -C . log` を hook allow することを再現した (従来は `~/.claude/settings.json` 由来の allow の印を外すだけで、`$CLAUDE_CONFIG_DIR` の deny / ask を読んでいなかった)。managed settings と main checkout の `settings.local.json` も同じく読んでいなかった。
- Claude Code は hook の環境に `CLAUDE_PROJECT_DIR` (セッションを開始したプロジェクトルート) を渡す。worktree に入った後も `CLAUDE_PROJECT_DIR` は開始時のまま、入力 JSON の `cwd` は Claude の作業ディレクトリ (worktree や `cd` 先) に追従する (<https://code.claude.com/docs/en/hooks>)。
- `extensions.worktreeConfig` が有効なリポジトリ (`git sparse-checkout init` / `set` で自動的に有効になる) では、git は common dir の `config` に加えて gitdir の `config.worktree` も読む。`commondir` を cwd の `.git` に向けた gitdir を作業ツリー内に手で作ると common dir の比較だけでは同一リポジトリに見え、その `config.worktree` の `core.fsmonitor` が `git -C <dir> status` で実行される (PR #272 のレビュー r4176525230 で再現)。
- 本体が設定ファイルの allow を適用しない構成がある (2026-10 時点のドキュメント)。hook がそれらの allow を根拠に allow を返すと、本体なら確認を出す (または classifier に回す) コマンドを確認無しに実行させる。
  - `--setting-sources user` や Agent SDK の `settingSources` でプロジェクト設定を除くと、本体はプロジェクトの `.claude/settings*.json` を読まない (<https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust>)。PR #272 のレビューで、`$CLAUDE_PROJECT_DIR/.claude/settings.json` に `allow: ["Bash(git submodule *)"]` を置くと `git -C . submodule foreach touch pwned` を hook allow することを再現した。
  - プロジェクトの `.claude/settings.json` の `permissions.allow` は、ワークスペースの信頼ダイアログを受け入れるまで適用されない。`claude -p` や SDK ではダイアログ自体が出ず、適用されない。deny / ask は制限する方向なので信頼に関係なく適用される (同上)。追跡されている `.claude/settings.local.json` も同じ扱い。
  - auto mode に入ると、本体は `Bash(*)`・`Bash(python*)` のようなインタプリタのワイルドカード・パッケージマネージャの run コマンドなど、任意コード実行を与える広い allow を落とす。`Bash(npm test)` のような狭い allow は残る (<https://code.claude.com/docs/en/permission-modes#how-the-classifier-evaluates-actions>)。PR #272 のレビューで、`~/.claude/settings.json` に `allow: ["Bash(*)"]` を置くと `git -C . submodule foreach touch pwned` を hook allow することを再現した。
- hook 入力 JSON の `permission_mode` は `"default"`・`"plan"`・`"acceptEdits"`・`"auto"`・`"dontAsk"`・`"bypassPermissions"` のいずれか。Manual モードは `"default"` で届く。全てのイベントが受け取るわけではないが、PreToolUse の入力例には含まれる (<https://code.claude.com/docs/en/hooks> の Common input fields)。各モードの本体の挙動は次のとおり (<https://code.claude.com/docs/en/permission-modes>)。
  - `default` / `acceptEdits`: allow ルールに一致するコマンドを自動許可し、それ以外の shell コマンドは確認を出す。
  - `plan`: auto mode が使える環境では既定 (`useAutoModeDuringPlan`) で shell コマンドを classifier に回す。使えない環境では組み込みの読み取り専用コマンド以外は確認を出す。
  - `auto`: 確認の代わりに classifier が判定する。
  - `dontAsk`: 確認になるはずの呼び出しを拒否する。allow ルールと PreToolUse hook が承認した呼び出しは実行する。
  - `bypassPermissions`: 確認を出さない (deny は効く)。
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
    - この照合に使う allow は、次の両方を満たすものだけ (`evaluator.ts` の `rulesForHookAllow`)。deny / ask は判定を厳しくする方向なので出自を問わず全て使う。
      - ユーザ設定 `~/.claude/settings.json` 由来 (`Rule.readByClaudeCode`)。プロジェクトの設定 (`$CLAUDE_PROJECT_DIR/.claude/settings.json` / `settings.local.json`、リポジトリ / main checkout のルートの `settings.local.json`、`cwd` 基準の `.claude/*`)、`.codex/*`、managed settings 由来の allow は根拠にしない (Codex 向けの読み込みと pass-through 時の判定は従来どおり)。プロジェクトの allow は、`--setting-sources user` / SDK の `settingSources` でプロジェクト設定を除いた場合と、ワークスペースを信頼していない場合に本体が適用しない。hook はどちらも入力から知る手段が無いので、出自で一律に外す。
      - `Bash(git <リテラルのサブコマンド>` で始まり、サブコマンドの直後が `)`・空白・`:*)` のいずれか (`Bash(git status *)`、`Bash(git status:*)`、`Bash(git stash list *)`)。`Bash(*)`・`Bash`・`Bash(git *)`・`Bash(git:*)`・`Bash(g*)`・`Bash(git status*)` のようにサブコマンドをリテラルで固定しない allow は根拠にしない。本体は auto mode で広い allow を落とすが、どれを落とすかの基準は列挙 (「`Bash(*)`、インタプリタのワイルドカードなど」) で、hook が同じ判定を再現する根拠が無い。hook は `git <sub>` に正規化したコマンドしか allow しないので、サブコマンド位置に anchor された allow だけを使えば足りる。
    - hook allow は本体の deny / ask を迂回させるので、hook は本体が読む deny / ask を全て自分で評価する。次を deny / ask の判定用に読む (`rules.ts` の `loadRules`)。
      - managed settings の `managed-settings.json` と `managed-settings.d/*.json` (OS ごとの既定の所在。テストでは `loadRules` の引数で注入する。環境変数による差し替えは hook の判定を外から変えられる口になるので設けない)。
      - `cwd` と `CLAUDE_PROJECT_DIR` それぞれの git リポジトリのルートと、worktree なら main checkout のルート (common dir の名前が `.git` ならその親) の `.claude/settings.local.json`。ルートは `isSameGitRepository` と同じファイルシステムだけの解決 (`git-repository.ts` の `localSettingsRootsOf`) で求める。ドキュメント上、本体は共有の `.claude/settings.json` を main checkout からは読まないので、そちらは読まない。
    - 本体が読む deny / ask を hook が読み切れない構成では hook allow しない (pass-through で本体のデフォルトプロンプトに委ねる)。
      - `CLAUDE_PROJECT_DIR` が無い・相対パス・実在しない。プロジェクトの allow は根拠にしなくなったが、本体はプロジェクトの deny / ask を (ワークスペースの信頼に関係なく) 適用するので、hook はその所在を知る必要がある。
      - `CLAUDE_CONFIG_DIR` が環境にある (値は問わない)。本体のユーザ設定はそこにあるが、hook はその所在を確実には追えない。`~/.claude` と同じ値でも、パス表記の比較で同一性を判断する分岐を持たない。
      - `HOME` が無い・空・相対パス。ユーザ設定の所在が分からない。相対パスを hook プロセスの作業ディレクトリ基準で解決していた (本体が読まないファイルに allow の印が付いていた) のをやめ、`~/` 配下の設定自体を読まない。
      - managed settings の所在が分からない OS (Windows など。レジストリは読まない)、managed settings のファイル / ドロップインディレクトリが読めない・JSON オブジェクトでない・`permissions` の `allow` / `deny` / `ask` が文字列の配列でない、macOS の MDM 構成プロファイル (`/Library/Managed Preferences/com.anthropic.claudecode.plist` とユーザごとの同名ファイル) がある、`allowManagedPermissionRulesOnly` が `false` 以外 (本体は不正な値を制限側に読む)、`policyHelper` または `wslInheritsWindowsSettings` のキーがある (値は問わない。本体はヘルパーが生成する managed settings や Windows 側の管理設定を適用しうるが、hook はその内容を読まない)。本体は壊れた managed settings では起動しないが、hook は例外にせず「allow しない」に倒す。
      - サーバー管理設定のキャッシュ `~/.claude/remote-settings.json` がある。形式がドキュメントに無く、適用中のポリシー (起動後の取得や 1 時間ごとの更新) と一致する保証も無いので、内容は評価しない。
      - `cwd` / `CLAUDE_PROJECT_DIR` が git リポジトリの中だが、本体が `settings.local.json` を読むルートを特定できない (`core.worktree`、手で作った gitdir、common dir の名前が `.git` でない linked worktree、`GIT_DIR` などの環境変数)。git 管理外なら本体も開始ディレクトリのファイルを読むので従来どおり。
  - `-C` の対象ディレクトリが、hook 入力の `cwd` のリポジトリと同じ git common dir を持つ (`git-repository.ts` の `isSameGitRepository`)。つまり同一リポジトリ内のサブディレクトリか、同一リポジトリの worktree に限る。
    - git は実行せず、ファイルシステムだけで解決する。パスは `chdir(2)` と同じく 1 要素ずつシンボリックリンクを解決して物理的に辿る (`fs.realpathSync` は `link/..` を字句的に畳むので使わない)。祖先方向に `.git` を探し、ディレクトリならそれを gitdir、ファイルなら `gitdir: <path>` (相対パスは `.git` ファイルの位置基準) の参照先を gitdir とする。gitdir に `commondir` があればその参照先 (相対パスは gitdir 基準)、無ければ gitdir 自体を common dir とし、cwd 側も同様に解決して比較する。
    - git が作った形の gitdir だけを認める。gitdir は (i) common dir 自身 (`commondir` が無い) か、(ii) `git worktree add` で作った linked worktree の gitdir、つまり `.git` ファイルの参照先が `<common>/worktrees/<name>` の直下で、git が書く逆リンク `<common>/worktrees/<name>/gitdir` が対象の `.git` ファイルを物理パスで指し返す (相対パスは `worktree.useRelativePaths` の形式で `<common>/worktrees/<name>` 基準) こと。`.git` ディレクトリに `commondir` がある形や、作業ツリー内に手で作った gitdir は common dir が一致しても認めない。
    - gitdir の `config.worktree` は、無いか、`git sparse-checkout` が書く `[core] sparseCheckout` / `sparseCheckoutCone` と `[index] sparse` の真偽値だけの場合に限る (allowlist)。`core.fsmonitor`・`core.hooksPath`・`core.sshCommand`・`core.pager`・`alias.*`・`diff.external` など実行やファイル参照につながるキーは数が多く denylist では網羅できないため。common config の `extensions.worktreeConfig` が有効かどうかは判定に使わない (キー名の大小文字・真偽値の表記揺れを解析する必要があり、無効なら git は読まないので余分に拒否するだけで安全側)。
    - 次はすべて allow しない (pass-through): cwd が無い・相対パス、`GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` / `GIT_CEILING_DIRECTORIES` などの環境変数が hook の環境にある、対象が存在しない・ディレクトリでない、`.git` ファイルの内容が不正、`.git` がシンボリックリンク、`.git` の無い階層に `HEAD` がある (bare リポジトリや `.git` 配下。git は `objects/` と `refs/` も揃った階層だけを gitdir とみなすが hook は区別しないので、作業ツリー内に `HEAD` という名前のエントリを持つディレクトリとその配下も含む)、上記の形でない gitdir、common dir の `config` に `worktree` / `bare` (false 以外) / `[include` の行がある、`config.worktree` に sparse-checkout 以外の設定がある、読み取りエラー。submodule や入れ子のリポジトリは別の common dir に解決されるので一致しない。例外は hook 全体を落とさず「allow しない」に倒す。
  - hook 入力 JSON の `permission_mode` が `"default"` か `"acceptEdits"` (`hook-response.ts` の `shouldEmitAllow`)。`"plan"`・`"auto"`・`"dontAsk"`・`"bypassPermissions"`、未知の値、欠落 (文字列でない値を含む) では allow を返さない (pass-through。deny / ask は従来どおり返す)。
    - hook の allow は本体の確認だけでなく auto mode の classifier もスキップさせる。allow を返してよいのは、本体が allow ルールで自動許可し、それ以外を確認に回すモード (hook allow が「ユーザ設定の allow を `-C` 版にも効かせる」以上の意味を持たないモード) に限る。
    - `auto` は classifier を、`dontAsk` は確認になるはずの呼び出しの拒否を、hook allow が迂回させる。`bypassPermissions` は本体が確認を出さないので hook が allow する意味が無い。
    - `plan` も外す。auto mode が使える環境では既定で shell コマンドを classifier に回し、使えない環境でも組み込みの読み取り専用コマンド以外は確認を出す。hook allow は `git -C . commit` のような書き込みを計画中に確認無しで実行させる。
    - 未知の値と欠落を外すのは、将来追加されるモードが classifier や自動拒否を使う可能性があり、許すモードを列挙 (allowlist) する側が安全なため。
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
- hook allow により、`git -C` はセッションの作業ディレクトリの外 (同一リポジトリの main checkout など) にも確認無しで届く。本体の作業ディレクトリ制限 (`blockReadsOutsideWorkingDirectories` / additionalDirectories) は file tools と組み込みの読み取り専用コマンドが対象で、Bash の hook allow との関係は検証していない。同一リポジトリ内に限るので受け入れる。
- 訂正: 同一 common dir 限定を導入した時点では「手で作った gitdir でも、git は gitdir の `config` ではなく common dir の `config` を読むので安全」としていた。`extensions.worktreeConfig` が有効なら git は gitdir の `config.worktree` も読むため、この前提は誤りだった。git が作った worktree だけを認め、`config.worktree` を sparse-checkout の設定だけに限ることで塞いだ。
- hook allow の根拠をユーザ設定のサブコマンドを固定した git の allow に限り、permission mode も限ったので、次は hook の自動許可を受けない。
  - `.codex/settings*.json` や `cwd` 基準の `.claude/settings*.json` だけにある allow (Codex 用の allow を Claude Code の `-C` 版に効かせることはしない)
  - プロジェクトの設定 (`$CLAUDE_PROJECT_DIR/.claude/settings.json` / `settings.local.json`、main checkout / リポジトリルートの `.claude/settings.local.json`) にだけある allow。本体の「次回から確認しない」はリポジトリルートの `settings.local.json` に保存されるので、そこで許可した `git <sub>` の `-C` 版は自動許可されない。`-C` 版も自動許可したいサブコマンドは `~/.claude/settings.json` に置く (このリポジトリは `.claude/settings.json` を `install.sh` でユーザ設定として配る)。これにより、未信頼のワークスペースや `--setting-sources user` / SDK の `settingSources` でプロジェクトの allow が適用されない構成で hook が allow する問題は解消する。
  - `Bash(*)`・`Bash(git *)` のような広い allow だけで許可しているサブコマンド
  - permission mode が `default` / `acceptEdits` 以外のセッション (`plan`・`auto`・`dontAsk`・`bypassPermissions`)。`auto` では `git -C` も classifier の判定になる
    - ユーザ設定の `permissions.defaultMode` を `auto` にしている場合、通常のセッションでは hook は pass-through になり (auto mode の classifier が判定する)、`git -C` の自動許可は `default` / `acceptEdits` に切り替えたセッションでだけ効く
  - `CLAUDE_PROJECT_DIR` を渡さない起動 (手動実行や他ツールからの起動)
  - `CLAUDE_CONFIG_DIR` を使う環境、`HOME` が使えない環境、managed settings を配布している環境のうち上記の hook allow しない条件に当たるもの (MDM 構成プロファイル、`allowManagedPermissionRulesOnly`、`policyHelper`、`wslInheritsWindowsSettings`、サーバー管理設定のキャッシュがある環境、Windows など)。これらの環境では `git -C` は常に本体のデフォルトプロンプトになる。`$CLAUDE_CONFIG_DIR/settings.json` の deny も hook は評価しないので、`-C` 版は deny ではなくプロンプトになる (確認無しには実行されない)。
- hook が読めない設定の deny / ask は hook allow で迂回されうる (既知の制約)。
  - サーバー管理設定 (claude.ai の組織ポリシーや Claude apps gateway が配る managed settings): キャッシュが無い状態 (初回起動、`-p` や SDK など approval を記録しない非対話の実行) では、hook はサーバー管理設定の存在を検知できない。
  - 埋め込みホスト (Claude Desktop、IDE 拡張、Agent SDK アプリ) が SDK の `managedSettings` で渡す parent settings、MDM 構成プロファイル以外 (Windows のレジストリなど) で配布された `policyHelper` / `wslInheritsWindowsSettings`、コマンドラインの `--settings`。
  - コマンドラインの `--disallowedTools` / SDK の `disallowedTools` で渡す deny。hook には渡らず、本体ではプレフィックス一致なので `-C` 版に効かない。例えば `claude -p --disallowedTools "Bash(git push *)"` の下でも `git -C . push` を hook allow する (PR #272 のレビューで再現)。`-C` 版を確実に止めたいサブコマンドは settings の deny に置く。
  - `--setting-sources` / SDK の `settingSources` でユーザ設定を除き、hook をプロジェクト設定から登録している構成: 本体はユーザ設定の allow を適用しないが、hook はそれを知る手段が無く `~/.claude/settings.json` の allow を根拠にする。このリポジトリではプロジェクトの `.claude/settings.json` とユーザ設定が同じ内容なので差は出ない。
  - `/cd` で移動した後のセッション: 本体は移動先の設定を読むが `CLAUDE_PROJECT_DIR` は開始時のまま。hook 入力の `cwd` が移動先に追従していれば、その `.claude/*` とリポジトリルートの `settings.local.json` の deny / ask は読む。
  - 所在の解決はドキュメントの記述に基づく。本体の実装 (所有者の確認、リポジトリルートがホームディレクトリの場合の扱いなど) と完全には一致しない。hook は本体より多くのファイルの deny / ask を読む側 (厳しい側) に倒している。
- 手で作った gitdir (`.git` ディレクトリに `commondir`、作業ツリー内の gitdir を指す `.git` ファイル) や、`config.worktree` に sparse-checkout 以外の設定 (`core.bare` など) がある worktree への `git -C` は hook の自動許可を受けない。
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

### Option F: `CLAUDE_CONFIG_DIR` があれば `$CLAUDE_CONFIG_DIR/settings.json` を読んで hook allow を続ける

- 概要: 本体と同じくユーザ設定の所在を `CLAUDE_CONFIG_DIR` に切り替え、その allow / deny / ask で判定する。
- 却下理由: 本体が値をどう解釈するか (相対パス・`~` の扱い、設定ホームとしての `settings.local.json` の扱いなど) をドキュメントから確定できず、hook の解釈がずれると deny / ask を取りこぼして黙って迂回させる。`CLAUDE_CONFIG_DIR` を使う環境は少数で、hook allow しなくても本体のプロンプトに落ちるだけ (安全側) なので、所在を追わずに hook allow を止める。

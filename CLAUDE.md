# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

日本語で必ず応答してください。

## Overview

macOS用の個人dotfilesリポジトリ。nix-darwin + home-manager (flakes) でシステム/ユーザー設定を宣言的に管理。

## Common Commands

```bash
DOTFILES_DIR=/path/to/dotfiles

# 初回セットアップ（Homebrew 導入 + nix-darwin bootstrap + install.sh をまとめて実行。冪等）
bash "$DOTFILES_DIR/bootstrap.sh"

# Nix管理の設定を適用（nix/ 以下を変更した後に実行）
sudo darwin-rebuild switch --flake "$DOTFILES_DIR/nix"

# Nix管理外ファイルのsymlinkを再作成（.config/, .local/bin/, .gitmessage 等を変更した後）
DOTFILES="$DOTFILES_DIR" bash "$DOTFILES_DIR/install.sh"
```

## Architecture

```text
nix/
  flake.nix                 # エントリポイント (nixpkgs unstable + nix-darwin + home-manager)
  configuration.nix         # system-level packages + locale + user
  home.nix                  # user-level: zsh, git, tmux, starship, bat, delta, etc.
  modules/
    homebrew.nix            # brew casks (GUI apps) / taps / formulae

.config/nvim/               # Neovim (LazyVim) — install.sh でsymlink
.config/ghostty/config      # Ghostty — install.sh でsymlink
.claude/settings.json       # Claude Code user設定 — install.sh で実体生成 (`~/.claude/settings.json` へ install -m 644。symlinkではない。詳細は「Orca による hook 自動注入と実体生成方式」節)
.claude/hooks/              # Claude Code hooks — install.sh でsymlink
.claude/commands/           # Claude Code commands — install.sh でsymlink
.claude/skills/             # Claude Code skills — rulesync で生成 (rulesync-claude/, kanade0404/skills を ref 固定取得。現在の tag は rulesync-claude/rulesync.jsonc の ref を参照)。project 単位のため install.sh でのグローバル symlink はしない
.codex/hooks.json           # Codex hooks — install.sh で実体生成 (`~/.codex/hooks.json` へ install -m 644。symlinkではない。詳細は「Orca による hook 自動注入と実体生成方式」節)
.codex/herdr-agent-state.sh # herdr hook (Codex用) — install.sh で個別に ~/.codex/herdr-agent-state.sh へsymlink。詳細は「herdr hook スクリプト」節
rulesync-claude/            # Claude 用 skill の rulesync 隔離パイプライン (config + lock)
.agents/skills/             # Codex 用 skills — rulesync で生成 (rulesync.jsonc) + install.sh でsymlink
.github/workflows/          # GitHub Actions (PR conflict 自動解決 etc.)
.local/bin/                 # ヘルパースクリプト (tmux-project, gw, codex-otel) — install.sh でsymlink
.gitignore                  # ⚠️ global な core.excludesFile (下記の注意を参照)
bootstrap.sh                # 初回セットアップ (Homebrew + nix-darwin bootstrap + install.sh)
bootstrap-codex-cloud.sh    # Codex Cloud 用の依存関係セットアップ
bootstrap-worktree.sh       # git worktree を参照元にして適用
install.sh                  # Nix 管理外ファイルの symlink 作成 + 一部ファイルの実体生成スクリプト (`.claude/settings.json` / `.codex/hooks.json` / `.codex/config.toml` の 3 ファイルは symlink ではなく実体生成。詳細は「Orca による hook 自動注入と実体生成方式」節を参照)
```

> ⚠️ **`.gitignore` は「このリポジトリ用」ではなく global な ignore**
> `install.sh` が `~/.gitignore` へ symlink し (`ln -sf "$DOTFILES/.gitignore" "$HOME/.gitignore"`)、
> `nix/home.nix` の `programs.git` で `excludesfile = "~/.gitignore"` として **core.excludesFile** に
> 設定している。つまりここに書いたパターンは **このマシンの全リポジトリに適用される**。
> `/env.json` のようにリポジトリ直下をアンカーしたパターンでも「全リポジトリのルートの
> `env.json`」を無視してしまうため、**dotfiles 固有のファイルを ignore したいだけの目的で
> ここにパターンを足さないこと** (どうしても必要なら `.git/info/exclude` を使う)。

## Where to Edit

| 変更内容 | 編集先 | 適用方法 |
|---------|--------|---------|
| CLIパッケージ追加 | `nix/configuration.nix` (systemPackages) | `darwin-rebuild switch` |
| GUIアプリ追加 | `nix/modules/homebrew.nix` (casks) | `darwin-rebuild switch` |
| Shell/Git/tmux/starship設定 | `nix/home.nix` | `darwin-rebuild switch` |
| Neovimプラグイン/設定 | `.config/nvim/lua/` | `install.sh` + nvim再起動 |
| Ghostty設定 | `.config/ghostty/config` | `install.sh` + Ghostty再起動 |
| ヘルパースクリプト追加 | `.local/bin/` に作成 + `install.sh` にsymlink追加 | `install.sh` |
| Claude Code設定/hooks/commands | `.claude/` 配下を編集 | `install.sh` (`.claude/settings.json` は symlink ではなく実体生成。「Orca による hook 自動注入と実体生成方式」節を参照) |
| Claude Code skill 追加 (自作) | [kanade0404/skills](https://github.com/kanade0404/skills) に `skills/<name>/SKILL.md` を追加 → push だけでは取得されない。kanade0404/skills は `ref` でタグ固定 (`rulesync-claude/rulesync.jsonc` の skills 配列は列挙不要) | 新 tag をリリース後、`rulesync.jsonc` / `rulesync-claude/rulesync.jsonc` の `ref` を更新 → `bun run rulesync:skills:claude:update` + `bun run rulesync:skills:update` + `install.sh` (両ファイルとも同じ source を参照するため、ref 更新時は両パイプラインの再解決が必要) |
| Claude/Codex skill の更新取込 | (kanade0404/skills の新 tag リリース後) `ref` を更新して再解決 | `bun run rulesync:skills:claude:update` / `rulesync:skills:update` |
| Codex 用 skill のソース変更 | kanade0404/skills は `ref` でタグ固定 (push だけでは取得されない)。tag 更新が必要 | `rulesync.jsonc` / `rulesync-claude/rulesync.jsonc` **両方**の `ref` を更新 → `bun run rulesync:skills:update` + `bun run rulesync:skills:claude:update` + `install.sh` (両ファイルは同じ source を参照するため ref 更新は常に両パイプライン同時。`.agents/skills` はグローバル symlink のため反映に必須) |
| GitHub Actions workflow | `.github/workflows/` を編集 | push (Actions が自動検出) |
| Claude Code テレメトリ (OTEL) のエンドポイント/挙動 | `.claude/settings.json` の `env` | `install.sh` (トークンは別管理。「Claude Code テレメトリ (OpenTelemetry)」節を参照) |
| Codex テレメトリ (OTEL) の生成ロジック | `.local/bin/codex-otel` (`.codex/config.toml` は tokenless template) | `install.sh` (トークンは別管理。「Codex テレメトリ (OpenTelemetry)」節を参照) |
| herdr hook (pane⇔agentセッション通知) | `.claude/hooks/herdr-agent-state.sh` (Claude用) / `.codex/herdr-agent-state.sh` (Codex用) | `install.sh` (実装は herdr 管理下。「herdr hook スクリプト」節を参照) |

## Claude Code テレメトリ (OpenTelemetry)

Claude Code の metrics / logs を OTLP エンドポイントへ export する設定。
**トークンは絶対にコミットしない**方針で、設定本体とトークンの供給経路を分離している。

構成: `Claude Code → OpenTelemetry Collector (Cloud Run) → Findy AI+ + Grafana Cloud` の
ファンアウト。以前は Findy AI+ への直送だったが、Collector 経由で複数バックエンドへ
分岐する形に変更した。Collector は受信を `bearertokenauth` で認証している。Collector 自体は
**別リポジトリ (private-infra) で Terraform 管理**しており、本リポジトリでは管理しない。

| 対象 | 置き場所 | 備考 |
|------|---------|------|
| エンドポイント・protocol・export interval 等 | `.claude/settings.json` の `env` (コミット済み) | `OTEL_EXPORTER_OTLP_HEADERS` はここに**入れない**。送信先は Collector (Cloud Run) |
| `Authorization: Bearer <token>` ヘッダー | `.claude/settings.json` の `otelHeadersHelper` → `.claude/hooks/otel-headers.sh` | helper が実行時にトークンを解決して JSON で返す |
| トークン実体 (ローカル) | macOS Keychain (service: `claude-code-otel`) | 値は Collector の受信トークン (`otel-collector-receiver-token`)。以前の Findy トークンから差し替え。dotfiles には一切書かない |
| トークン実体 (cloud) | claude.ai/code の Environment variables で `OTEL_EXPORTER_TOKEN` | 同上 |

トークンの解決順序 (`.claude/hooks/otel-headers.sh`):

1. 環境変数 `OTEL_EXPORTER_TOKEN` が非空ならそれを使う
2. macOS なら Keychain から取得
3. どちらも無ければ `{}` を返して静かに続行 (ヘッダーなしで export され、セッションは落ちない)

取得できたトークンは前後の空白 (スペース・タブ・改行) を除去してから使う (Keychain 登録時に
紛れ込んだ空白で無効なヘッダーを送り続けるのを防ぐため)。それでも内部に制御文字が残る場合は
JSON として壊れるため `{}` を返して静かに続行する。`settings.json` 側のラッパー式も、helper が見つからない場合は
`exec` せず `{}` を stdout に出して `exit 0` する (「取れなければ `{}`」という不変条件を
helper 本体とラッパーの両方で守る)。

Keychain への登録:

```bash
security add-generic-password -s "claude-code-otel" -a "$USER" -w '<token>' -U
```

注意点:

- `settings.json` の `env` の値は `${VAR}` 展開をサポートしない (リテラル文字列のみ)。
  かつシェルの `export` を**上書きする**ため、トークンは `env` ではなく helper 経由で供給している
- `otelHeadersHelper` の値は「実ファイルなら直接 exec、そうでなければ `/bin/sh -c` で実行」という
  2 段構えで解釈されるためシェル式を書ける。ローカルは `$HOME/.claude/hooks/otel-headers.sh`
  (install.sh が貼る symlink)、cloud は `git rev-parse --show-toplevel` で clone root を解決する
- ⚠️ リポジトリ内フォールバックは **origin が `kanade0404/dotfiles` の場合に限定**している。
  この `settings.json` は user settings としてローカルの全プロジェクトに効くため、無条件に
  `git rev-parse --show-toplevel` を使うと、`$HOME` 側の helper が不在・非実行になった状態で
  任意の git リポジトリを開いたときに、**そのリポジトリが同梱する `.claude/hooks/otel-headers.sh`
  を無確認で `exec` する**経路になる (helper 実行に trust プロンプトは無い)。
  `git config --get remote.origin.url` を照合して自リポジトリだけに絞り、一致しなければ
  `{}` を返して静かに続行する (cloud session は origin が一致するのでこれまで通り動く)。
  照合は**部分一致ではなく canonical な URL の完全一致列挙**にすること。
  `*kanade0404/dotfiles*` のような部分一致だと `evilkanade0404/dotfiles` や
  `dotfiles-evil`、`evil.example.com/kanade0404/dotfiles` にもマッチし、
  ガードを入れた意味が無くなる
- ⚠️ **残余リスク: origin URL 照合は trust boundary としては不完全**。
  `git config --get remote.origin.url` の値はカレントリポジトリの `.git/config` 由来、
  つまり**リポジトリ作成者が自由に設定できるデータ**なので、悪意あるリポジトリが
  `origin` を `https://github.com/kanade0404/dotfiles.git` に詐称して
  `.claude/hooks/otel-headers.sh` を同梱すれば、このガードは通過してしまう。
  成立には「user settings 経由でこの helper が読まれる」「`$HOME` 側 helper が不在/非実行」
  「その悪意リポジトリで workspace trust を承認済み」の 3 条件が揃う必要があるため
  受容しているが、**このガードは「無関係なリポジトリを巻き込まないための足切り」であって、
  能動的な攻撃者を止めるものではない**。
  根本的に断つには install.sh 適用済み (= `$HOME` 側 helper が常に存在する) 状態を保つこと
- helper には引数も stdin も渡されず、`CLAUDE_PROJECT_DIR` も渡されない。実行ビット必須 (無いと exit 126)。
  呼び出しは既定 29 分デバウンス / 1 回 30 秒 timeout
- ⚠️ `otelHeadersHelper` は**キー自体は公式ドキュメント (Monitoring usage) に記載がある**。
  「値は実行ファイルのパスでも引数付きのシェルコマンドラインでもよい」「既定 29 分間隔で
  再実行される (`CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS` で変更可)」までが公式記載。
  一方、**「実ファイルなら直接 exec / そうでなければ `/bin/sh -c`」という非 Windows での
  解釈のされ方と「1 回 30 秒 timeout」は公式に記載が無く、Claude Code 2.1.226 での実測値**。
  この 2 点は将来のリリースで無言に変わりうる (helper が呼ばれない / タイムアウトする形で
  現れる) ので、バージョンを上げた際は改めて確認すること
- **cloud session (claude.ai/code) は `~/.claude/settings.json` (user settings) を読まない**。
  リポジトリ内の `.claude/settings.json` のみ有効なので、**この dotfiles リポジトリ以外の
  cloud session ではテレメトリ設定は効かない**
- cloud の Environment variables UI は専用のシークレットストアではなく、公式 docs も資格情報を
  置かないよう警告している。トークンをそこに置くかはユーザーの判断
- `env.json` は旧来のローカル設定ファイル。内容は `.claude/settings.json` の `env` に
  取り込み済みなので**削除した** (`.gitignore` にも登録しない。理由は下記「`.gitignore` は
  global core.excludesFile」の注意を参照)
- ⚠️ **この `env` は `~/.claude/settings.json` (user settings) 経由でローカルの全プロジェクトに
  適用される**。`OTEL_LOG_TOOL_DETAILS=1` は bash コマンド文字列やファイルパスを含むため、
  業務リポジトリで実行したコマンドも export される (`OTEL_LOG_USER_PROMPTS=0` により
  プロンプト本文は除外)。この範囲で export することを承知のうえで `1` にしている
- ⚠️ **このリポジトリは PUBLIC**。`.claude/settings.json` は clone した第三者にとって
  project settings にもなるため、その人が dotfiles ディレクトリで Claude Code を起動し、
  初回の **workspace trust (このフォルダのファイルを信頼するか) を承認した後は**
  テレメトリ export が試みられる。トークンを持たないため `Authorization` ヘッダーは付かないが、
  **リクエスト自体は送信される** (trust を承認しなければ project settings の `env` は
  有効にならないので、無条件に送信されるわけではない)。受信側 (Collector の
  `bearertokenauth`) で無認証リクエストを弾く前提の設計であり、設定ファイル側では
  ガードしていない

## 危険 git コマンドのガード (rule-matcher)

`permissions.deny` から `Bash(git -C *)` を外している (別ディレクトリへの読み取り系
`git -C` を通すため)。その代わり、破壊的な git は `.claude/hooks/lib/rule-matcher.ts` の
`checkDangerousGitFlags` が deny に昇格させる。ガードは 2 層:

| 種別 | 条件 | 例 |
|------|------|----|
| `alwaysDangerous` | サブコマンドに一致した時点で危険 | `reset` / `rebase` / `checkout` |
| `dangerousWhenRedirected` | `-C` / `--git-dir` / `--work-tree` / `GIT_DIR=` 等で**ディレクトリを付け替えた場合のみ**危険 | `rm` / `config` / `stash` / `reflog` / `worktree` / `cherry-pick` 等 |

後者は「CWD 内なら allow されている操作でも、付け替えるとプロジェクト外の任意
リポジトリに届いてリスクの性質が変わる」ものを拾う。判定前に、シェルキーワード /
コマンド前置 / 一時環境変数前置 / 先頭リダイレクトを剥がし、タブ区切り・クォート・
ANSI-C quoting (`$'\x72eset'`)・フルパス (`/usr/bin/git`) を正規化する。

- インライン `-c` のうち **`core.fsmonitor` / `core.hooksPath` / `core.sshCommand` /
  `alias.*` は付け替えの有無によらず deny**。これらは指定しただけで任意コマンドが走る
  (`git -c core.fsmonitor=/evil status` で成立するため `-C` すら要らない)。
  `core.pager` / `core.editor` は `-c core.pager=cat` のような正当な常用形があるので
  意図的に対象外にしている。**環境変数経由の config 注入**
  (`GIT_CONFIG_PARAMETERS` / `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_N`) も同じキー集合で
  同様に deny する (`-c` だけ塞いでも同じ RCE が通るため)。
  config を介さず直接コマンドを起動する環境変数
  (`GIT_SSH_COMMAND` / `GIT_SSH` / `GIT_EXTERNAL_DIFF` / `GIT_ASKPASS` /
  `GIT_PROXY_COMMAND` / `GIT_SEQUENCE_EDITOR`) も同じ扱い。
  `GIT_PAGER` / `GIT_EDITOR` は `core.pager` / `core.editor` と同じ理由で対象外。
  **transport ヘルパー** (`--upload-pack` / `--receive-pack` / `ext::` リモート) も
  git が任意コマンドを起動する同クラスなので deny する
- 検出は**サブコマンドより前の global option / env 前置区間だけ**を走査する。
  コマンド全体を見るとコミットメッセージ等の引数 (`git commit -m GIT_SSH_COMMAND=x`) や
  同名のサブコマンドフラグ (`git commit -c <commit-ish>`) を誤検知して deny してしまう
- **付け替え時は `config` の読み取り (`--get` / `--list`) も deny になる**。
  書き込みと読み取りをフラグで見分ける実装にせず、安全側に倒した意図的な選択。
  他リポジトリの config を読む用途が稀なので、誤検知の害よりガードの単純さを取った
- **`commit` は意図的に対象外**。`git -C <repo> commit` は (エージェントが絶対パスで
  リポジトリを操作する等) 正当な常用パターンで、かつコミット作成自体はデータを失わない。
  `dangerousWhenRedirected` の趣旨は「他リポジトリのデータを壊す / 実行経路を仕込む」
  ことの阻止なので commit はその枠に入らない
- ⚠️ **`DANGEROUS_GIT_FLAGS` は denylist であって網羅ではない**。ここに無い破壊的
  サブコマンドは `-C` 経由で他リポジトリに届く。新しい経路に気付いたら表に足すこと
- ⚠️ **`sh -c` / `zsh -c` / `dash -c` のラッパー経由はガードが一切効かない**
  (parser が `-c` の引数を展開しないため)。追跡は #177
- ⚠️ **対象リポジトリ側の repo-local config は静的解析では防げない**。
  `git -C <path> log` のような読み取り系でも、その `<path>/.git/config` に
  `core.pager` / `core.fsmonitor` / `core.hooksPath` が仕込まれていれば任意コマンドが走る
  (同一ユーザ所有なら `safe.directory` チェックも通過する)。コマンド文字列を見る
  ガードの原理的な射程外。信頼できないリポジトリを触るときは
  `git -c core.fsmonitor= -c core.pager=cat --no-pager -C <path> ...` のように
  明示的に無効化するか、そもそも `-C` で触らないこと

## Codex テレメトリ (OpenTelemetry)

Codex CLI の logs / metrics / traces を Claude Code と同じ Collector へ export する設定。
Codex の `[otel]` は `~/.codex/config.toml` の user-level config で有効。
headers は静的値なので **トークンを dotfiles にコミットしない**ために、`install.sh` が
`.local/bin/codex-otel --write-config-only` を実行して `~/.codex/config.toml` に managed block を追記する。

構成: `.codex/config.toml (tokenless template) → install.sh → ~/.codex/config.toml (生成・0600) → codex`。
これにより `codex` / `cc` の通常起動でも OTEL 設定が有効になる。

| 対象 | 置き場所 | 備考 |
|------|----------|------|
| OTEL endpoint / protocol / export 対象 | `.local/bin/codex-otel` (コミット済み) | logs `/v1/logs`, metrics `/v1/metrics`, traces `/v1/traces`, `protocol = "json"` |
| Codex が読む OTEL config | `~/.codex/config.toml` (`install.sh` が生成) | `# BEGIN CODEX OTEL MANAGED` block にトークンを含みうるため repo に入れない |
| トークン実体 | 環境変数 `OTEL_EXPORTER_TOKEN` / macOS Keychain | 解決順は `OTEL_EXPORTER_TOKEN` → service `codex-otel` → service `claude-code-otel` |

Collector endpoint は `.claude/settings.json` と `.local/bin/codex-otel` の 2 箇所にあるため、変更時は両方を同時に更新する。
Claude Code の OTEL env var は `http/json` を使うが、Codex TOML の `protocol` は Codex config schema に合わせて `json` を使う。

Keychain へ Codex 専用 service として登録する場合:

```bash
security add-generic-password -s "codex-otel" -a "$USER" -w '<token>' -U
```

既存の Claude Code 用 `claude-code-otel` service も fallback で読むので、同じ Collector token を共有するだけなら追加登録なしでよい。
`CODEX_OTEL_ENVIRONMENT` / `CODEX_OTEL_LOGS_ENDPOINT` / `CODEX_OTEL_METRICS_ENDPOINT` /
`CODEX_OTEL_TRACES_ENDPOINT` で生成値を上書きできる。

Claude Code は helper を起動時に再実行してトークンをディスクへ書かないが、Codex は headers が静的 TOML のため
`~/.codex/config.toml` の managed block に bearer token を平文 (mode 600) で保持する。token をローテーションしたら
`install.sh` または `.local/bin/codex-otel --write-config-only` を再実行して managed block を再生成すること。
一時的に token を解決できない場合、既存 managed block に `Authorization` が残っていれば書き換えをスキップし、既存ヘッダーを保持する。
`install.sh` はリポジトリの `.codex/config.toml` を正として `~/.codex/config.toml` を置き換えるため、
既存のローカル Codex 設定は保持しない。手書き設定が必要な場合は、実行前にバックアップして
`.codex/config.toml` へ移行するか、`install.sh` ではなく `.local/bin/codex-otel --write-config-only` を直接実行し、
`CODEX_OTEL_CONFIG_TARGET` で別ファイルへ生成する。
既存の `~/.codex/config.toml` に手書きの `[otel]` / `[otel.*]` table がある場合は、重複 table で Codex config を壊さないため
生成を失敗させる。手書き設定を削除するか、managed block 側へ移行してから再実行する。
`~/.codex/config.toml` の更新は read-modify-write で lock しないため、`cc` 同時起動や Codex runtime の同時書き込みがあると last-writer-wins になる。
`cc` alias は通常起動向けに `.local/bin/codex-otel` を通す。config 更新に失敗しても警告だけ出し、テレメトリ都合で Codex セッションを落とさない。
`cc` は interactive zsh alias として意図的に Codex 用に使う。C コンパイラが必要な対話操作では `/usr/bin/cc` などフルパスで呼ぶ。

## herdr hook スクリプト (SessionStart → pane/agent通知)

tmux pane と AI agent セッションを紐付けるための herdr 向け SessionStart hook。
スクリプト**内部**に `HERDR_ENV=1` / `HERDR_SOCKET_PATH` / `HERDR_PANE_ID` / `python3` の
4段ガードがあり、いずれか欠ければ静かに `exit 0` する。

ただしこの 4 段ガードは「スクリプトが存在して起動できた」後の話で、**スクリプト自体が
無い環境** (install.sh 未適用のマシン・cloud session・この PUBLIC repo を clone した
第三者) では届かない。そのため hook 定義側にも存在ガードを置き、
`h="$HOME/..."; [ -f "$h" ] || exit 0; exec bash "$h" session` の形で
**スクリプト不在なら hook 自体が静かに `exit 0`** するようにしている
(ガード無しだと `bash: No such file or directory` で exit 127 となり、
毎セッション起動時にエラーが出続ける)。`otelHeadersHelper` 側の
「helper が見つからなければ `{}` + `exit 0`」と同じ不変条件を hook 側にも揃えた形。

なお herdr は tmux pane と紐付けるローカル専用の仕組みなので、`otelHeadersHelper` と違い
**cloud 用のリポジトリ内フォールバック (`git rev-parse --show-toplevel` 経由の解決) は
意図的に持たない** (cloud には tmux も herdr socket も無く、解決できても何もできないうえ、
任意のリポジトリ同梱スクリプトを exec する経路を増やすだけになるため)。

| 対象 | 場所 | integration id / version |
|------|------|------|
| Claude Code 用 | `.claude/hooks/herdr-agent-state.sh` | `HERDR_INTEGRATION_ID=claude`, v10 |
| Codex 用 | `.codex/herdr-agent-state.sh` | `HERDR_INTEGRATION_ID=codex`, v8 |

- 両者は agent 種別・イベント絞り込み条件・payload が異なる別物。**統合しない**
- 役割: hook 入力 JSON から `session_id` を抜き、herdr の Unix domain socket へ
  `pane.report_agent_session` JSON-RPC を送信する (herdr バイナリ自体は呼ばない)。
  `session_id` が文字列として取れなければ何も送らない
- python 側のガードは v10 / v8 で異なる。シェル側 4 段ガードの後に以下が走る:
  - **Claude 用 (v10)**: 環境変数 `CURSOR_VERSION` か hook 入力の `cursor_version` が
    あれば exit (Cursor 経由の起動を除外)。`hook_event_name` が `SessionStart` 以外
    (空文字含む) なら exit。hook 入力に `agent_id` があれば subagent とみなして exit
    (v8 の `CODEX_THREAD_ID` 判定に相当する段)。`transcript_path` は**あれば**
    `agent_session_path` として params に載せる — 必須ではない
  - ⚠️ `CURSOR_VERSION` は**環境変数**判定なので誤爆しうる。tmux server は最初に起動した
    クライアントの環境を継承して以後の全 pane に伝播するため、一度でも Cursor の統合
    ターミナルから tmux server を起動すると、その server 上の**正規の Claude Code
    セッションでも無言で `exit 0`** になり pane 紐付けが効かなくなる (診断出力は出ない)。
    紐付かないときはまず `tmux show-environment -g CURSOR_VERSION` / hook プロセスの
    environ を疑うこと。スクリプトは herdr 管理下なので直接編集はせず、
    「hook 入力の `cursor_version` のみで判定する」形を upstream へ報告するのが筋
    (追跡は #242。**未報告**の状態で、報告したら issue 側を更新すること)
  - **Codex 用 (v8)**: `hook_event_name` が空でなく `SessionStart` 以外なら exit。
    `transcript_path` は **必須ゲート**で、欠落 / 空白のみなら送信せず exit する
    (ゲートに使うだけで params には載せない)。さらに `CODEX_THREAD_ID` が
    **設定されており、かつ**入力の `session_id` と一致しない場合のみ subagent とみなして
    exit する (**未設定なら通過する** — fresh pane はこちら)
- ⚠️ Codex の SessionStart 入力に `transcript_path` が**常に**含まれるかは未検証。
  Codex 公式の hook 仕様では nullable なので、含まれないケースがあると Codex 側の
  herdr 連携は**無言で全停止**する (追跡は #242。**未報告**。#239 の既知懸念と同根)
- 配布: `.claude/hooks/*` は install.sh のワイルドカードで `~/.claude/hooks/` と
  `~/.codex/hooks/` の両方へ symlink。`.codex/herdr-agent-state.sh` は個別の `ln -sf` 行で
  `~/.codex/herdr-agent-state.sh` へ配布
- hook 定義: `.claude/settings.json` の `hooks.SessionStart` / `.codex/hooks.json` の
  `hooks.SessionStart` (いずれも存在ガード付きの
  `h="$HOME/..."; [ -f "$h" ] || exit 0; exec bash "$h" session` 形式)
- 注意: スクリプト冒頭に `managed by herdr; reinstalling or updating the integration
  overwrites this file.` とある。install.sh 適用後は `~/.claude/hooks/herdr-agent-state.sh`
  が dotfiles への symlink になるため、**herdr を再インストール/更新すると symlink 越しに
  dotfiles リポジトリ内の実体が書き換わり git diff として現れる** (追跡できるのは利点だが、
  意図しない差分に見えうるので注意)

## Orca による hook 自動注入と実体生成方式

**Orca** (`/Applications/Orca.app`、bundle id `com.stablyai.orca`) は tmux pane と AI agent
セッションを紐付けるローカル専用ツール。herdr と役割は近いが別の仕組みで、Orca は
**新しい pane / PTY を開くたびに** `~/.claude/settings.json` (13 イベント分) と
`~/.codex/hooks.json` (8 イベント分) へ自分の hook を注入する。ファイル監視による
自動修復ではなく、あくまで pane 起動のタイミングでのみ書き込む。

以前はこの 2 ファイルを dotfiles への symlink で配布していたため、**Orca の注入が
git 管理下の実体を直接書き換えてしまっていた**。実際に以下が発生していた:

- `$HOME` へ正規化されているべきパスが `/Users/kanade0404/...` のようなハードコードへ
  巻き戻る
- `.claude/settings.json` から `model` キーが脱落する

⚠️ `model` 脱落は Orca が意図的に削除したものではなく、**ロック無しの read-modify-write
によるレース**が原因。Orca が「全文読み込み → hooks だけ差し替え → 全文書き戻し」する窓の
間に Claude Code がローカルの `model` 設定を書き込むと、Orca の書き戻しでその変更が
上書きされて消える。

対応として `install.sh` を実体生成方式に変更し、この 2 ファイルを
**symlink 配布から実体生成方式へ移行**した (#239)。

加えて、両ファイルの template には **Orca 用 hook 定義を置かない**方針にしている
(一度 commit したものを PR 内で戻しただけなので、この方針は **net diff には「除去」として
現れない**。ブランチ履歴には除去コミットとして残るので、merge commit で取り込まれた場合は
master の履歴からも辿れる)。理由は Orca hook が **ローカル専用**だから:
cloud session (claude.ai/code) には Orca が存在しないため、repo 内 `.claude/settings.json`
に置いても毎イベント空振りの存在チェックが走るだけのコストにしかならない (cloud session が
読まないのは `~/.claude/settings.json` (user settings) **だけ**で、**リポジトリ内の
`.claude/settings.json` は cloud でも読まれる**。だからこそ repo 側に Orca hook を置くと
cloud でも空振りの存在チェックが走ってしまう)。Orca hook は pane 起動時に
Orca 自身がローカルの実体へ注入するのに任せる。

実体生成の実装は `install.sh` の `install_managed_file` ヘルパーに
統一されている: `mktemp "$dest.tmp.XXXXXX"` で衝突しない一時ファイルを作り、
`install -m <mode>` でそこへ書き込んでから `mv -f` (`rename(2)`) でアトミックに差し替える。
`rm -f dest && install src dest` にしなかったのは、source (dotfiles 側) が無い時に
「dest を消してから install が失敗 → `set -e` で abort」となり、以降の処理が走らないまま
既存設定 (`permissions.deny` の危険 git ガードや PreToolUse hook を含む) だけが無言で
失われる退行が実際に起きたため (#239 で修正)。この方式なら source 不在時も install
自体が失敗するだけで **dest は無傷のまま残る**。`~/.codex/config.toml` も同じヘルパーに
統一済みで、`.claude/settings.json` / `.codex/hooks.json` / `.codex/config.toml` の 3 ファイル
とも実装は同一。mode だけ前者 2 つが 644、config.toml が 600 と異なる (config.toml は OTEL
トークンを平文で含みうるため)。EXIT trap (`cleanup_install`) が生成に使った一時ファイルと
(config.toml の) バックアップの両方を掃除する。EXIT trap は untrapped fatal signal では
走らないため、`HUP` / `INT` / `QUIT` / `TERM` にも `cleanup_install_and_exit` (掃除してから
`exit $((128 + signum))`) を張っている。張らないと中断時に `settings.json.tmp.XXXXXX` 等が
`$HOME` に残り、temp の記録はプロセス内の配列にしか無いので**次回実行でも掃除されない**。
exit code を 128 + signum にしているのは、通常の install 失敗 (exit 1) と中断を
呼び出し元 (`bootstrap.sh` 等) から区別できるようにするため。
残余リスク: `mktemp` が返ってから配列へ append するまでの極小窓で signal を受けると、
trap は配列しか見ないのでその temp だけ掃除から漏れる (stray file 1 個)。glob ベースの
掃除にすれば塞げるが、複雑さに見合わないので受容している。
なお signal 経路では **codex config のバックアップは消さない**。`~/.codex/config.toml` を
template で置換してから `codex-otel --write-config-only` が Authorization を書き戻すまでの
窓で中断すると、そのバックアップが旧 config の唯一のコピーになるため。変数を空にしてから
場所を stderr に出し、後続の EXIT trap にも消させない。
⚠️ **クリアを `echo` より先に置くこと**。`set -e` は trap 本体にも効くうえ、SIGHUP は端末
消失時に届くので `>&2` への write が EIO で失敗しうる。echo を先に書くとその失敗で
クリア前に `exit 1` し、EXIT trap がバックアップを消してしまう (exit code も
128 + signum でなくなる)。echo 自体にも `|| true` を付ける。
また、この窓は `codex-otel` の呼び出しが終わった時点で閉じるので、**その直後に明示的に
バックアップを掃除して変数を空にする**。そうしないと、窓の外 (hooks.json / settings.json の
置換中など) で中断したときに bearer token を平文で含むコピーが `${TMPDIR:-/tmp}` に
残り続ける。`codex-otel` が失敗した場合の `retain_codex_config_backup` も同じ規律で、
**失敗しても errexit で abort させない** (abort すると EXIT trap が唯一のコピーを消す)。
移せなかったときは変数を空にしてから場所を警告に出す。

⚠️ **`install` の失敗は必ずその場で `return 1` すること** (`install ... || return 1`)。
単に行を並べると、errexit が抑止された文脈
(`install_managed_file ... || warn` / `if ! install_managed_file ...` / `&&` の右辺) で
呼ばれたときに install の失敗後も `mv` が走り、**mktemp が作った空ファイルで dest を潰した
うえで関数が 0 を返す**。install.sh は既に「失敗しても警告だけで続行」パターン
(`codex-otel --write-config-only` の呼び出し) を持っているため、将来それに倣った瞬間に
`~/.claude/settings.json` が警告すら出ずに空になる。安全性を呼び出し側の ambient errexit に
委ねず関数内に閉じること。`mktemp` 側も `|| return 1` を明示する。

同じ理由で **dest が directory の場合は関数の冒頭で弾く** (`[ -d "$dest" ]` → `return 1`)。
`mv -f tmp dest` は dest が directory (または directory への symlink) だと置き換えではなく
「tmp を dest の中へ移動」になって 0 を返すため、置き換わっていないのに成功する経路が残る。
⚠️ このガード (と `.bak` の種別ガード) が保証するのは **呼び出し時点の状態だけ**で、
lock は取っていないため `mv` 実行時点は保証しない。判定と `mv` の間に dest が directory 化
されれば同じ経路が成立する (`~/.codex/config.toml` の read-modify-write が last-writer-wins
なのと同クラスの残余リスクとして受容している)。

⚠️ **install.sh を再実行するとローカルの hook 登録がリセットされる**。Orca hook は次に
pane を開けば Orca が再注入するため実害は無いが、Claude Code 自身が `~/.claude/settings.json`
に書き込んだローカル設定は `install.sh` の `install_managed_file` (上記のアトミック置換) で
dotfiles 側の内容に巻き戻り、失われる。具体例は `/model` で選んだモデル、そして
**とりわけ影響が大きいのが `/permissions` で追加した allow/deny**。symlink 配布時代は
Orca の書き換えが repo 側の実体にそのまま現れて git diff で気付けたが、実体生成方式では
「ローカルに黙って溜まり、次の install.sh 実行で黙って消える」方向に変わった。UI で承認した
allow/deny が install.sh のたびに巻き戻って同じ承認を繰り返す、あるいは危険コマンド用に
足した deny が消えたことに気付かないまま運用する、といった形で表面化しうる。
緩和として `install.sh` は上書き前の内容を **1 世代だけ `<dest>.bak` へ退避**する
(`backup_local_settings`)。`~/.claude/settings.json.bak` / `~/.codex/hooks.json.bak` から
手で戻せるという意味であって、巻き戻り自体に気付かせる仕組みではない点に注意。
世代は増やさないので、**貴重な `.bak` は次の install.sh 実行で上書きされうる**。
残るかどうかを決めるのは下記の `cmp -s` だが、その比較は
**「dest が前回から変化したか」ではなく「dest と今回 staging した新しい source が同じか」**
である点に注意 (実装は `cmp -s "$dest" "$staged"`)。したがって:

- dest がローカルで一切変化していなくても、**dotfiles 側の source が更新されていれば**
  差分ありとなって退避が走り、`.bak` が「素の前回 dotfiles 内容」で上書きされる。
  1 回目に取れた貴重な退避 (`permissions.deny` 等) はここで失われる
- dest も source も変わっていなければ退避は no-op になり、前回の `.bak` が残る

`.bak` に残したい内容があると分かっている場合は、install.sh を再実行する前に自分で
別の場所へコピーしておくこと。
退避の細かい規律は 6 つ:

- **退避は source の staging に成功してから**行う (`install_managed_file` の第 4 引数
  `backup` 経由で、`install` 成功後・`mv` の直前に呼ぶ)。呼び出し側で先に退避すると、
  source 不在で install が失敗する経路で dest は無傷なのに `<dest>.bak` だけ潰れ、
  復旧手段そのものが消える
- **dest が今回 staging した source と同一内容なら退避しない** (`cmp -s "$dest" "$staged"`)。
  差分ゼロで install.sh を 2 回走らせただけで、1 回目の意味ある退避が dotfiles と同一の
  内容で潰れるのを防ぐ。**source が更新されている場合は差分ありになるので退避は走る**
  (上記の注意を参照)
- **`<dest>.bak` が regular file でなければ退避せず中止**する。directory だと
  `cp` は「中へコピー」、symlink だとリンク先へ書き込みになり、「`.bak` から手で戻せる」
  契約が黙って破れる (`[ -d "$dest" ]` ガードと同じ趣旨)
- **退避に失敗したら `return 1` で置き換えを中止**する (best-effort 続行にしない)。
  退避の存在理由は「巻き戻りからの復旧」なので、それが取れない状態で dest を上書きすると
  **保険が最も必要な瞬間に限って**ローカル設定の唯一のコピーが不可逆に失われる。
  中止時点で dest は無傷なので、原因 (ENOSPC / permission / 壊れた `.bak`) を直して
  再実行すればよい。source 不在時に `return 1` する経路と同じ扱い
- **退避も temp + `mv` で差し替える**。`cp` は出力先を `O_TRUNC` で開くので、既存の
  `.bak` へ直接書くと書き込み開始時点で旧内容が失われ、途中で失敗 (ENOSPC 等) すると
  唯一の復旧コピーが壊れた断片に化けたまま dest も巻き戻ってしまう
- **第 4 引数が `backup` でも空でもなければ `return 1`**。stringly-typed なフラグなので、
  typo (`bakcup` 等) が黙って「退避なし」に落ちないよう `case` で明示的に弾く。
  検証は `mktemp` / `install` の副作用より**前**に置き、失敗パスを「何もしていない
  状態からの `return 1`」に保つ

`~/.codex/config.toml` は対象外: Authorization の引き継ぎを
`CODEX_OTEL_PRESERVE_AUTH_FROM` で別に持っており、bearer token の平文コピーを
`$HOME` に増やさないため。なお「差分があれば**警告する**」(`cmp -s` の警告用途) は
採っていない — Orca が pane 起動のたびに hook を注入する以上 dest は**ほぼ常に**
dotfiles 側と異なり、毎回出る警告は読まれなくなるため (同じ `cmp -s` でも、上記の
「同一なら退避をスキップ」は no-op 化であって警告を増やさないので採用している)。
(`/config` のテーマ変更は `~/.claude/settings.json` ではなく `~/.claude.json` 側に保存されて
いることを確認済み (`grep -n theme ~/.claude.json` すると実際に選んだテーマが出るが、
`~/.claude/settings.json` 側の `theme` キーはこの dotfiles にコミット済みの静的な既定値
(`"auto"`) のままで一致しない)。`~/.claude.json` は install.sh の対象外なので、テーマ変更はこの巻き戻りの
対象ではない)

参考: Codex は `CODEX_HOME` と `ORCA_CODEX_HOME` が一致していれば Orca の隔離ホーム
(`~/Library/Application Support/orca/codex-runtime-home/home`) を使うが、Orca の worktree
管理下でない実フォルダを pane で開くと隔離が効かず実ホームに直接書く。**Claude Code 側には
この隔離ホーム機構自体が存在しない**。

Orca 側で注入自体を止める手段もある (未検証・参考情報として記載):

| 範囲 | 方法 | 備考 |
|------|------|------|
| エージェント単位 | `~/Library/Application Support/orca/profiles/local-default/orca-data.json` の `state.settings.disabledTuiAgents` に `"claude"` / `"codex"` を追加 | Orca の Settings UI 経由と推測。CLI セッターは未発見 |
| 全体一括 | `orca agent hooks off` / `on` / `status` | 未公開 CLI サブコマンド (`--help` に出ない) |

ただしどちらの方法も Orca の pane 紐付け機能自体を失う。

⚠️ **このリポジトリは PUBLIC**。実体生成方式に変えても `.claude/settings.json` /
`.codex/hooks.json` の内容自体は引き続きコミット済みで誰でも読める。今回変えたのは
「ローカルの実体が Orca に書き換えられて git diff に紛れ込む」問題への対処であって、
機密情報の扱いは変わらない (トークンは従来通り Keychain / helper 経由で別管理)。

## Nix-specific Notes

- `nix.enable = true` — nix-darwin に `/etc/nix/nix.conf` を管理させる (`experimental-features = nix-command flakes` もここで設定)。Determinate Nix を入れる場合は `false` に戻すこと
- `homebrew.onActivation.cleanup = "zap"` — `homebrew.nix` に記載されていないパッケージは `darwin-rebuild switch` 時に自動削除される
- ホスト名 `kanade0404` (configuration.nix で宣言的に管理)、アーキテクチャ `aarch64-darwin`
- flake の `darwinConfigurations` attribute もホスト名と同じ `kanade0404` にしてあるので、適用は `sudo darwin-rebuild switch --flake "$DOTFILES_DIR/nix"` だけでよい (attribute 指定不要)
- home-managerは nix-darwin module として統合（standalone ではない）

## 管理方針

| 対象 | 管理方法 | 理由 |
|------|---------|------|
| CLI packages | `configuration.nix` (systemPackages) | システム全体で利用 |
| Shell/Git/tmux設定 | `home.nix` (home-manager) | 宣言的管理 + 自動symlink |
| Neovim設定 | dotfiles直接管理 + install.sh | LazyVim (lazy.nvim) との競合回避 |
| Ghostty設定 | dotfiles直接管理 + install.sh | home-manager module未対応 |
| Claude Code設定 | dotfiles直接管理 + install.sh (`.claude/settings.json` は実体生成) | プロジェクト横断で統一 + Orca 等ローカルツールによる書き換えから git 管理下の実体を守る |
| Node.js | mise (nixpkgs 管理) | プロジェクト毎のバージョン管理。将来的に Nix devShell へ移行検討 |

## 開発ワークフロー

- **ターミナル**: Ghostty
- **エディタ**: Neovim (LazyVim) + GitHub Copilot
- **多重化**: tmux (prefix: `C-a`)
- **AI**: Claude Code (`c` alias, tmux Window 4) / Codex (`cc` alias)
- **Git**: lazygit (tmux Window 5) + git worktree (`gw` コマンド)
- **テーマ**: GitHub Light で統一 (Ghostty, tmux, fzf, bat, delta, Neovim)

## コミット規約

`.gitmessage`テンプレートに従う絵文字プレフィックス付きコミット。

フォーマット: `:emoji: Subject`

| 絵文字 | 用途 |
|--------|------|
| `:sparkles:` | 新機能追加 |
| `:tada:` | 大きな機能追加 |
| `:+1:` | 機能改善 |
| `:bug:` | バグ修正 |
| `:recycle:` | リファクタリング |
| `:pencil2:` | ドキュメント |
| `:shower:` | 不要な機能の削除 |
| `:up:` | 依存パッケージ更新 |
| `:green_heart:` | テスト/CI改善 |
| `:shirt:` | Lint修正 |
| `:rocket:` | パフォーマンス改善 |
| `:lock:` | 新機能の制限 |
| `:cop:` | セキュリティ改善 |

## Linear → Claude Code 自走パイプライン (Anthropic Routines)

Linear で `claude:ready` ラベルが付いた issue を、Anthropic Routines (`/schedule`
で登録した cron) が 1 時間毎に拾い、リモートの Claude Code セッションで
PR 作成 → CI all green → レビューコメント全解消まで完遂させる仕組み。
ローカル Mac (および 1Password SSH agent) には依存しない。

| コンポーネント | 役割 | 場所 |
|---|---|---|
| Routine | 1 時間毎に skill を起動するクラウド側 cron | Anthropic 側 (`/schedule list` で確認) |
| skill | clone → 実装 → PR → CI → review 対応の手順書 | `.claude/skills/linear-issue-driven-development/SKILL.md` |
| slash command | 手動再実行用 `/linear-issue <ID>` | `.claude/commands/linear-issue.md` |

セットアップ:

1. `/schedule` で routine を登録 (prompt は SKILL.md 冒頭 + orchestrator 部、または
   PR description に貼った "routine prompt" テンプレを使う)
2. routine の secrets に以下を設定:
   - `LINEAR_API_KEY` — Linear Personal API Key
   - `GH_TOKEN` — repo / workflow / write 権限の PAT
   - `ANTHROPIC_API_KEY` — routine 実行用 (登録時に自動)
3. Linear で対象 issue に `claude:ready` ラベルを付ける

ラベル状態遷移: `claude:ready` → `claude:in-progress` → `claude:done` / `claude:failed`

無限ループ防止: CI 失敗 3 連 / レビュー対応 5 周で `claude:failed` を付けて停止。

Routine の進捗は `/schedule list` および routine 詳細ページの session ログで確認。
手動で 1 件だけ流したい時はローカル Claude Code で `/linear-issue <IDENTIFIER>`。

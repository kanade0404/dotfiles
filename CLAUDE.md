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
.claude/settings.json       # Claude Code user設定 — install.sh でsymlink
.claude/hooks/              # Claude Code hooks — install.sh でsymlink
.claude/commands/           # Claude Code commands — install.sh でsymlink
.claude/skills/             # Claude Code skills — rulesync で生成 (rulesync-claude/, kanade0404/skills を ref 固定取得。現在の tag は rulesync-claude/rulesync.jsonc の ref を参照)。project 単位のため install.sh でのグローバル symlink はしない
.codex/herdr-agent-state.sh # herdr hook (Codex用) — install.sh で個別に ~/.codex/herdr-agent-state.sh へsymlink。詳細は「herdr hook スクリプト」節
rulesync-claude/            # Claude 用 skill の rulesync 隔離パイプライン (config + lock)
.agents/skills/             # Codex 用 skills — rulesync で生成 (rulesync.jsonc) + install.sh でsymlink
.github/workflows/          # GitHub Actions (PR conflict 自動解決 etc.)
.local/bin/                 # ヘルパースクリプト (tmux-project, gw) — install.sh でsymlink
.gitignore                  # ⚠️ global な core.excludesFile (下記の注意を参照)
bootstrap.sh                # 初回セットアップ (Homebrew + nix-darwin bootstrap + install.sh)
bootstrap-codex-cloud.sh    # Codex Cloud 用の依存関係セットアップ
bootstrap-worktree.sh       # git worktree を参照元にして適用
install.sh                  # Nix 管理外ファイルの symlink 作成スクリプト
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
| Claude Code設定/hooks/commands | `.claude/` 配下を編集 | `install.sh` |
| Claude Code skill 追加 (自作) | [kanade0404/skills](https://github.com/kanade0404/skills) に `skills/<name>/SKILL.md` を追加 → push だけでは取得されない。kanade0404/skills は `ref` でタグ固定 (`rulesync-claude/rulesync.jsonc` の skills 配列は列挙不要) | 新 tag をリリース後、`rulesync.jsonc` / `rulesync-claude/rulesync.jsonc` の `ref` を更新 → `bun run rulesync:skills:claude:update` + `bun run rulesync:skills:update` + `install.sh` (両ファイルとも同じ source を参照するため、ref 更新時は両パイプラインの再解決が必要) |
| Claude/Codex skill の更新取込 | (kanade0404/skills の新 tag リリース後) `ref` を更新して再解決 | `bun run rulesync:skills:claude:update` / `rulesync:skills:update` |
| Codex 用 skill のソース変更 | kanade0404/skills は `ref` でタグ固定 (push だけでは取得されない)。tag 更新が必要 | `rulesync.jsonc` / `rulesync-claude/rulesync.jsonc` **両方**の `ref` を更新 → `bun run rulesync:skills:update` + `bun run rulesync:skills:claude:update` + `install.sh` (両ファイルは同じ source を参照するため ref 更新は常に両パイプライン同時。`.agents/skills` はグローバル symlink のため反映に必須) |
| GitHub Actions workflow | `.github/workflows/` を編集 | push (Actions が自動検出) |
| Claude Code テレメトリ (OTEL) のエンドポイント/挙動 | `.claude/settings.json` の `env` | `install.sh` (トークンは別管理。「Claude Code テレメトリ (OpenTelemetry)」節を参照) |
| herdr hook (pane⇔agentセッション通知) | `.claude/hooks/herdr-agent-state.sh` (Claude用) / `.codex/herdr-agent-state.sh` (Codex用) | `install.sh` (実装は herdr 管理下。「herdr hook スクリプト」節を参照) |

## Claude Code テレメトリ (OpenTelemetry)

Claude Code の metrics / logs を OTLP エンドポイントへ export する設定。
**トークンは絶対にコミットしない**方針で、設定本体とトークンの供給経路を分離している。

| 対象 | 置き場所 | 備考 |
|------|---------|------|
| エンドポイント・protocol・export interval 等 | `.claude/settings.json` の `env` (コミット済み) | `OTEL_EXPORTER_OTLP_HEADERS` はここに**入れない** |
| `Authorization: Bearer <token>` ヘッダー | `.claude/settings.json` の `otelHeadersHelper` → `.claude/hooks/otel-headers.sh` | helper が実行時にトークンを解決して JSON で返す |
| トークン実体 (ローカル) | macOS Keychain (service: `claude-code-otel`) | dotfiles には一切書かない |
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
  `{}` を返して静かに続行する (cloud session は origin が一致するのでこれまで通り動く)
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
  有効にならないので、無条件に送信されるわけではない)。受信側 (API Gateway) の authorizer で
  無認証リクエストを弾く前提の設計であり、設定ファイル側ではガードしていない

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
| Claude Code 用 | `.claude/hooks/herdr-agent-state.sh` | `HERDR_INTEGRATION_ID=claude`, v7 |
| Codex 用 | `.codex/herdr-agent-state.sh` | `HERDR_INTEGRATION_ID=codex`, v6 |

- 両者は agent 種別・イベント絞り込み条件・payload が異なる別物。**統合しない**
- 役割: hook 入力 JSON から `session_id` / `transcript_path` を抜き、herdr の Unix domain
  socket へ `pane.report_agent_session` JSON-RPC を送信する (herdr バイナリ自体は呼ばない)
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
| Claude Code設定 | dotfiles直接管理 + install.sh | プロジェクト横断で統一 |
| Node.js | mise (nixpkgs 管理) | プロジェクト毎のバージョン管理。将来的に Nix devShell へ移行検討 |

## 開発ワークフロー

- **ターミナル**: Ghostty
- **エディタ**: Neovim (LazyVim) + GitHub Copilot
- **多重化**: tmux (prefix: `C-a`)
- **AI**: Claude Code (`cc` alias, tmux Window 4)
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

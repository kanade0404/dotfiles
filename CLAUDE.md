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
  flake.nix              # エントリポイント (nixpkgs unstable + nix-darwin + home-manager)
  configuration.nix      # system-level packages + locale + user
  home.nix               # user-level: zsh, git, tmux, starship, bat, delta, etc.
  modules/
    homebrew.nix         # brew casks (GUI apps) / taps / formulae

.config/nvim/            # Neovim (LazyVim) — install.sh でsymlink
.config/ghostty/config   # Ghostty — install.sh でsymlink
.claude/settings.json    # Claude Code user設定 — install.sh でsymlink
.claude/hooks/           # Claude Code hooks — install.sh でsymlink
.claude/commands/        # Claude Code commands — install.sh でsymlink
.claude/skills/          # Claude Code skills — rulesync で生成 (rulesync-claude/, kanade0404/skills を ref 固定取得。現在の tag は rulesync-claude/rulesync.jsonc の ref を参照)。project 単位のため install.sh でのグローバル symlink はしない
rulesync-claude/         # Claude 用 skill の rulesync 隔離パイプライン (config + lock)
.agents/skills/          # Codex 用 skills — rulesync で生成 (rulesync.jsonc) + install.sh でsymlink
.github/workflows/       # GitHub Actions (PR conflict 自動解決 etc.)
.local/bin/              # ヘルパースクリプト (tmux-project, gw) — install.sh でsymlink
bootstrap.sh             # 初回セットアップ (Homebrew + nix-darwin bootstrap + install.sh)
bootstrap-codex-cloud.sh # Codex Cloud 用の依存関係セットアップ
bootstrap-worktree.sh    # git worktree を参照元にして適用
install.sh               # Nix 管理外ファイルの symlink 作成スクリプト
```

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

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

日本語で必ず応答してください。

## Overview

macOS用の個人dotfilesリポジトリ。nix-darwin + home-manager (flakes) でシステム/ユーザー設定を宣言的に管理。

## Common Commands

```bash
# Nix管理の設定を適用（nix/ 以下を変更した後に実行）
sudo darwin-rebuild switch --flake ~/work/dotfiles/nix

# Nix管理外ファイルのsymlinkを再作成（.config/, .local/bin/, .gitmessage 等を変更した後）
bash ~/work/dotfiles/install.sh
```

## Architecture

```
nix/
  flake.nix              # エントリポイント (nixpkgs unstable + nix-darwin + home-manager)
  configuration.nix      # system-level packages + locale + user
  home.nix               # user-level: zsh, git, tmux, starship, bat, delta, etc.
  modules/
    homebrew.nix         # brew casks (GUI apps) / taps / formulae
    services.nix         # AeroSpace tiling WM config

.config/nvim/            # Neovim (LazyVim) — install.sh でsymlink
.config/ghostty/config   # Ghostty — install.sh でsymlink
.claude/settings.json    # Claude Code user設定 — install.sh でsymlink
.claude/hooks/           # Claude Code hooks — install.sh でsymlink
.claude/commands/        # Claude Code commands — install.sh でsymlink
.local/bin/              # ヘルパースクリプト (tmux-project, gw) — install.sh でsymlink
install.sh               # 上記のsymlink作成スクリプト
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

## Nix-specific Notes

- `nix.enable = false` — Determinate Nixがdaemonを管理するため、nix-darwinでは無効化
- `homebrew.onActivation.cleanup = "zap"` — `homebrew.nix` に記載されていないパッケージは `darwin-rebuild switch` 時に自動削除される
- ホスト名 `SeiyanoMacBook-Air`、アーキテクチャ `aarch64-darwin`
- home-managerは nix-darwin module として統合（standalone ではない）

## 管理方針

| 対象 | 管理方法 | 理由 |
|------|---------|------|
| CLI packages | `configuration.nix` (systemPackages) | システム全体で利用 |
| Shell/Git/tmux設定 | `home.nix` (home-manager) | 宣言的管理 + 自動symlink |
| Neovim設定 | dotfiles直接管理 + install.sh | LazyVim (lazy.nvim) との競合回避 |
| Ghostty設定 | dotfiles直接管理 + install.sh | home-manager module未対応 |
| Claude Code設定 | dotfiles直接管理 + install.sh | プロジェクト横断で統一 |
| Node.js | mise (将来的にNix devShellへ移行) | プロジェクト毎のバージョン管理 |

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

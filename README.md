# dotfiles

macOS (Apple Silicon) 用の個人 dotfiles。nix-darwin + home-manager (flakes) でシステム/ユーザー設定を宣言的に管理。

## セットアップ

### 前提条件

- macOS (aarch64-darwin)
- [Determinate Nix](https://determinate.systems/nix-installer/)

### インストール

```bash
# Nix 管理の設定を適用
sudo darwin-rebuild switch --flake ~/work/dotfiles/nix

# Nix 管理外ファイルの symlink を作成
bash ~/work/dotfiles/install.sh
```

## 構成

```
nix/
  flake.nix              # エントリポイント (nixpkgs unstable + nix-darwin + home-manager)
  configuration.nix      # system-level packages + locale + user
  home.nix               # user-level: zsh, git, tmux, starship, bat, delta, etc.
  modules/
    homebrew.nix         # brew casks (GUI apps) / taps / formulae
    services.nix         # AeroSpace tiling WM config

.config/nvim/            # Neovim (LazyVim)
.config/ghostty/config   # Ghostty terminal
.claude/                 # Claude Code (settings, hooks, commands)
.local/bin/              # ヘルパースクリプト (tmux-project, gw)
install.sh               # symlink 作成スクリプト
```

## 管理方針

| 対象 | 管理方法 | 適用コマンド |
|------|---------|-------------|
| CLI パッケージ | `nix/configuration.nix` | `darwin-rebuild switch` |
| GUI アプリ | `nix/modules/homebrew.nix` | `darwin-rebuild switch` |
| Shell / Git / tmux | `nix/home.nix` | `darwin-rebuild switch` |
| Neovim | `.config/nvim/` | `install.sh` |
| Ghostty | `.config/ghostty/` | `install.sh` |
| Claude Code | `.claude/` | `install.sh` |

## Claude Code Hooks

TypeScript 製の PreToolUse hook で Bash コマンドの権限を統合管理。

- `settings.json` の `permissions.allow/deny/ask` ルールでコマンドを判定
- シェルコマンドを構文解析（パイプ、`&&`、コマンド置換、ヒアドキュメント等）
- dangerous-git-flags 検出（`--no-verify`, `--force` 等の位置非依存チェック）
- deny 時に代替ツールを案内（`ls` → Glob ツール、`cat` → Read ツール等）

```bash
# テスト実行
bun test
```

## 開発環境

- **ターミナル**: Ghostty
- **エディタ**: Neovim (LazyVim) + GitHub Copilot
- **多重化**: tmux (prefix: `C-a`)
- **AI**: Claude Code
- **Git**: lazygit + git worktree
- **テーマ**: GitHub Light

# dotfiles

macOS (Apple Silicon) 用の個人 dotfiles。nix-darwin + home-manager (flakes) でシステム/ユーザー設定を宣言的に管理。

## セットアップ

### 前提条件

- macOS (aarch64-darwin)
- [Determinate Nix](https://determinate.systems/nix-installer/) がインストール済みであること
- このリポジトリが任意の clone/worktree パスに配置されていること

### 初回セットアップ (bootstrap.sh)

初回は以下 1 コマンドで完結します。内部で Homebrew インストール / experimental features 有効化 / `/etc/{bashrc,zshrc,zprofile}` 退避 / nix-darwin ブートストラップ / symlink 作成 を一気通貫で実行します。

```bash
DOTFILES_DIR=/path/to/dotfiles
bash "$DOTFILES_DIR/bootstrap.sh"
```

スクリプトは冪等なので再実行しても安全です (既にインストール済みの項目はスキップします)。

### 2 回目以降の更新

```bash
DOTFILES_DIR=/path/to/dotfiles

# Nix 管理の設定を適用 (configuration.nix / home.nix / modules/ 変更時)
sudo darwin-rebuild switch --flake "$DOTFILES_DIR/nix"

# Nix 管理外ファイルの symlink 再作成 (.config/, .local/bin/, .claude/ 等変更時)
DOTFILES="$DOTFILES_DIR" bash "$DOTFILES_DIR/install.sh"
```

### worktree から適用する場合

git worktree 上の内容をそのまま Nix / symlink の参照元にしたい場合は、worktree 内で以下を実行します。

```bash
./bootstrap-worktree.sh
```

`install.sh` は実行された checkout/worktree を既定の dotfiles 参照元として使います。明示したい場合は `DOTFILES=/path/to/dotfiles bash install.sh` も利用できます。

Codex の worktree 作成時 setup script のような非対話環境では、`sudo` が使えないため `/etc` ファイル退避と `darwin-rebuild` は自動でスキップされ、symlink 作成のみ実行されます。Nix 管理の設定まで適用したい場合は、作成後に対話ターミナルで `sudo darwin-rebuild switch --flake <worktree>/nix` を実行してください。

### Codex Cloud で使う場合

Codex Cloud では macOS / nix-darwin / Homebrew / symlink セットアップを行わず、Bun と依存関係だけをセットアップします。

```bash
./bootstrap-codex-cloud.sh
```

setup 中にテストまで実行したい場合は以下を使います。

```bash
RUN_TESTS=1 ./bootstrap-codex-cloud.sh
```

### 新しい Mac で使う場合

`nix/flake.nix` の `darwinConfigurations."kanade0404"` と `nix/configuration.nix` の `networking.hostName` を自分のホスト名に合わせて変更してから `bootstrap.sh` を実行してください (同一ホスト名で運用するなら変更不要)。

## 構成

```
nix/
  flake.nix              # エントリポイント (nixpkgs unstable + nix-darwin + home-manager)
  configuration.nix      # system-level packages + locale + user
  home.nix               # user-level: zsh, git, tmux, starship, bat, delta, etc.
  modules/
    homebrew.nix         # brew casks (GUI apps) / taps / formulae

.config/nvim/            # Neovim (LazyVim)
.config/ghostty/config   # Ghostty terminal
.claude/                 # Claude Code (settings, hooks, commands)
.local/bin/              # ヘルパースクリプト (tmux-project, gw)
bootstrap.sh             # 初回セットアップ (Homebrew インストール + nix-darwin bootstrap + install.sh)
bootstrap-codex-cloud.sh # Codex Cloud 用の依存関係セットアップ
bootstrap-worktree.sh    # git worktree を参照元にして適用
install.sh               # Nix 管理外ファイルの symlink 作成
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

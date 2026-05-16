# dotfiles

macOS (Apple Silicon) 用の個人 dotfiles。nix-darwin + home-manager (flakes) でシステム/ユーザー設定を宣言的に管理。

## セットアップ

### 前提条件

- macOS (aarch64-darwin)
- [Determinate Nix](https://determinate.systems/nix-installer/) がインストール済みであること
- このリポジトリが `~/work/dotfiles` に clone されていること

### 初回セットアップ (bootstrap.sh)

初回は以下 1 コマンドで完結します。内部で Homebrew インストール / experimental features 有効化 / `/etc/{bashrc,zshrc,zprofile}` 退避 / nix-darwin ブートストラップ / symlink 作成 を一気通貫で実行します。

```bash
bash ~/work/dotfiles/bootstrap.sh
```

スクリプトは冪等なので再実行しても安全です (既にインストール済みの項目はスキップします)。

### 2 回目以降の更新

```bash
# Nix 管理の設定を適用 (configuration.nix / home.nix / modules/ 変更時)
sudo darwin-rebuild switch --flake ~/work/dotfiles/nix

# Nix 管理外ファイルの symlink 再作成 (.config/, .local/bin/, .claude/ 等変更時)
bash ~/work/dotfiles/install.sh
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
.claude/                 # Claude Code (settings, hooks, commands, skills)
.github/workflows/       # PR conflict 自動解決 workflows
.local/bin/              # ヘルパースクリプト (tmux-project, gw)
bootstrap.sh             # 初回セットアップ (Homebrew インストール + nix-darwin bootstrap + install.sh)
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

## GitHub Actions: PR conflict 自動解決

`.github/workflows/` に Claude Code Action を用いた PR conflict 自動解決の仕組みを同梱しています。

| ファイル | 役割 |
|---------|-----|
| `.github/workflows/scan-pr-conflicts.yml` | 毎日深夜 (JST 00:00 / UTC 15:00) に open PR を走査。`mergeable: CONFLICTING` の PR ごとに matrix job (= 1 session) を割り当て、`@claude` メンションを PR にコメント |
| `.github/workflows/claude.yml` | `@claude` メンション (issue/PR コメント・review) を検出して [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) を実行 |
| `.claude/skills/pr-conflict-resolver/SKILL.md` | conflict 解決の安全手順 (checkout → merge → 解決 → lock 再生成 → 検証 → push → 報告) を Claude に渡す skill |

### 有効化手順

1. リポジトリの **Settings > Secrets and variables > Actions** に `ANTHROPIC_API_KEY` を登録
   - claude.ai/code 経由の OAuth を使う場合は `CLAUDE_CODE_OAUTH_TOKEN` を代わりに登録し、`claude.yml` の `with:` を差し替える
2. **Settings > Actions > General** で *Allow GitHub Actions to create and approve pull requests* を有効化
3. push したリポジトリで実際に conflict した PR を作って動作確認 (`workflow_dispatch` から `scan-pr-conflicts` を手動実行することも可能)

### 二重トリガ回避

`scan-pr-conflicts` は PR コメントに `<!-- scan-pr-conflicts marker:v1 -->` を埋め込み、24h 以内に
同マーカーのコメントが存在する PR には再度依頼しません。意図的に再実行したい場合は workflow_dispatch
で `pr_numbers` を指定するか、該当コメントを手で削除してから再実行してください。

### 動作フロー

```
deep-night cron ──▶ scan-pr-conflicts
                       │
                       ├─ gh pr list で CONFLICTING な open PR を抽出
                       │
                       └─ PR ごとに matrix job:
                           └─ "@claude resolve conflicts ..." を PR にコメント

@claude コメント ──▶ claude.yml (issue_comment event)
                       │
                       └─ claude-code-action 実行
                           └─ pr-conflict-resolver skill に従って自動修正 → push
                                  │
                                  └─ CI 緑になったら人手で merge
                                       (= 次回以降は @claude メンションで再駆動可能)
```

## 開発環境

- **ターミナル**: Ghostty
- **エディタ**: Neovim (LazyVim) + GitHub Copilot
- **多重化**: tmux (prefix: `C-a`)
- **AI**: Claude Code
- **Git**: lazygit + git worktree
- **テーマ**: GitHub Light

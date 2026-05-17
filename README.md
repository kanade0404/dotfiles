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
.claude/                 # Claude Code (settings, hooks, commands, skills)
.github/workflows/       # PR conflict 自動解決 workflows
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

## GitHub Actions: PR conflict 自動解決

`.github/workflows/` に Claude Code Action を用いた PR conflict 自動解決の仕組みを同梱しています。

| ファイル | 役割 |
|---------|-----|
| `.github/workflows/scan-pr-conflicts.yml` | 毎日深夜 (JST 00:00 / UTC 15:00) に open PR を走査。`mergeable: CONFLICTING` の PR ごとに matrix job (= 1 session) を割り当て、その job 内で [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) を直接実行して conflict を解決 |
| `.github/workflows/claude.yml` | 人間が PR/issue で `@claude` メンションした際に手動で claude-code-action を起動 (merge 後の追従対応・手動依頼用) |
| `.claude/skills/pr-conflict-resolver/SKILL.md` | conflict 解決の安全手順 (checkout → merge → 解決 → lock 再生成 → 検証 → push → 報告) を Claude に渡す skill |

> **設計メモ**: GitHub の再帰防止ポリシーにより `GITHUB_TOKEN` で投稿したコメントは
> 別 workflow の `issue_comment` を起動しません。そのため scan は「コメントで claude.yml を起こす」のではなく
> matrix job 内で claude-code-action を `prompt` モードで直接実行します (PAT 不要)。

### 有効化手順

1. Claude Code CLI でこのリポジトリ上で `/install-github-app` を実行
   - Claude GitHub App のインストールと、`CLAUDE_CODE_OAUTH_TOKEN`
     (Max/Pro 契約内課金用 OAuth トークン) のリポジトリ Secret 登録を自動で行う
   - 両 workflow は既定で `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`
     を参照する。従量 API キーを使う場合は **Settings > Secrets and variables > Actions** に
     `ANTHROPIC_API_KEY` を登録し、両 workflow の `claude_code_oauth_token:` を
     `anthropic_api_key:` に差し替える
2. **Settings > Actions > General** で *Allow GitHub Actions to create and approve pull requests* を有効化
3. push したリポジトリで実際に conflict した PR を作って動作確認 (`workflow_dispatch` から `scan-pr-conflicts` を手動実行することも可能)

> **keyless 構成について**: Anthropic API 直の場合は Secret が必須。静的キーを置きたくない場合は
> AWS Bedrock (`use_bedrock` + GitHub OIDC) か GCP Vertex AI
> (`use_vertex` + Workload Identity Federation) 経由にすると `id-token: write` 権限のみで運用できる。

### 二重トリガ回避

`scan-pr-conflicts` は処理開始時に PR へ `<!-- scan-pr-conflicts marker:v1 -->` を含む
監査コメントを投稿し、24h 以内に **bot (`github-actions[bot]`) が投稿した** 同マーカーの
コメントが存在する PR は再処理しません (第三者が同文字列を投稿しても抑止は迂回されません)。
dedup チェックは `workflow_dispatch` でも無条件に実行されるため、意図的に再実行したい場合は
**該当のマーカーコメントを手で削除してから** 再実行してください。`workflow_dispatch` の
`pr_numbers` は conflict 状態に関わらず特定 PR を対象に含めるための指定であり、
これだけでは 24h dedup は回避できません (マーカー削除が別途必要)。

### CI 再実行に関する注意

claude-code-action が `GITHUB_TOKEN` で push したコミットは、再帰防止ポリシーにより
`push` / `pull_request` トリガの CI を再実行しません。CI を確実に回したい場合は、
解決後の PR で空コミットを足すか、PR を一度 close/reopen するか、`secrets` に PAT を
用意して checkout / push をその PAT で行うよう workflow を調整してください
(個人 dotfiles 用途では手動 re-run でも十分なため既定では PAT 不要)。

### 動作フロー

```text
deep-night cron ──▶ scan-pr-conflicts
                       │
                       ├─ detect: gh pr list で CONFLICTING な open PR を抽出
                       │
                       └─ resolve: PR ごとに matrix job (= 1 session):
                           ├─ 24h dedup チェック
                           ├─ 監査コメント投稿 (marker 埋め込み)
                           ├─ PR head ブランチを checkout
                           └─ claude-code-action (prompt モード) を直接実行
                               └─ pr-conflict-resolver skill に従って解決 → push
                                      │
                                      └─ CI 緑になったら人手で merge

@claude コメント (人間) ──▶ claude.yml (issue_comment event)
                              └─ claude-code-action を起動 (手動依頼・追従対応用)
```

## 開発環境

- **ターミナル**: Ghostty
- **エディタ**: Neovim (LazyVim) + GitHub Copilot
- **多重化**: tmux (prefix: `C-a`)
- **AI**: Claude Code
- **Git**: lazygit + git worktree
- **テーマ**: GitHub Light

#!/usr/bin/env bash
# 初回のみ実行する bootstrap スクリプト
# - Homebrew 本体のインストール (未導入なら)
# - Nix の experimental features を一時的に有効化 (bootstrap 用)
# - macOS 既定の /etc/{bashrc,zshrc,zprofile} を退避
# - nix-darwin の初回ブートストラップ (darwin-rebuild 未インストール)
# - Nix 管理外ファイルの symlink 作成 (install.sh)
#
# 2 回目以降は `sudo darwin-rebuild switch --flake ~/work/dotfiles/nix` で十分。
set -euo pipefail

DOTFILES_DIR="${DOTFILES_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
FLAKE_ATTR="kanade0404" # nix/flake.nix の darwinConfigurations に合わせる

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

can_use_sudo() {
  sudo -n true 2>/dev/null || [ -t 0 ]
}

# ---- prerequisites ----
[ "$(uname)" = "Darwin" ] \
  || die "bootstrap.sh は macOS 専用です。Linux/クラウド環境では 'bash install.sh' のみ実行してください"

command -v nix >/dev/null \
  || die "Nix が見つかりません。先に Determinate Nix をインストールしてください: https://determinate.systems/nix-installer/"

# ---- Homebrew ----
if [ -x /opt/homebrew/bin/brew ]; then
  log "Homebrew は既にインストール済み"
else
  log "Homebrew をインストール"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv)"

# ---- サードパーティ tap の信頼 (Homebrew 5.1+) ----
# 新しい Homebrew は非公式 tap の formula/cask を読み込む前に明示的な信頼を要求する
# (HOMEBREW_REQUIRE_TAP_TRUST)。未信頼だと darwin-rebuild の brew bundle が
# "Refusing to load formula ... from untrusted tap" で失敗するため、ここで trust する。
# nix/modules/homebrew.nix の taps と一致させること。
log "サードパーティ tap を信頼登録"
for tap in ariga/tap microsoft/apm; do
  brew trust "$tap"
done

# ---- Nix experimental features (一時ユーザー設定) ----
# darwin-rebuild 初回は flakes/nix-command が必須。bootstrap 完了後は /etc/nix/nix.conf が
# nix-darwin によって管理されるので、このユーザー設定は冗長になる。
if nix config show experimental-features 2>/dev/null | grep -qw flakes \
  && nix config show experimental-features 2>/dev/null | grep -qw nix-command; then
  log "Nix experimental features は既に有効"
else
  log "Nix experimental features を一時有効化 (~/.config/nix/nix.conf)"
  mkdir -p "$HOME/.config/nix"
  touch "$HOME/.config/nix/nix.conf"
  grep -q '^experimental-features' "$HOME/.config/nix/nix.conf" \
    || printf 'experimental-features = nix-command flakes\n' >> "$HOME/.config/nix/nix.conf"
fi

# ---- macOS 既定の shell 初期化ファイル退避 ----
if can_use_sudo; then
  log "macOS 既定の /etc/{bashrc,zshrc,zprofile} を退避 (nix-darwin が上書き生成するため)"
  for f in /etc/bashrc /etc/zshrc /etc/zprofile; do
    if [ -f "$f" ] && [ ! -L "$f" ] && [ ! -f "$f.before-nix-darwin" ]; then
      sudo mv "$f" "$f.before-nix-darwin"
    fi
  done
else
  warn "非対話環境で sudo を使えないため /etc ファイル退避をスキップ"
fi

# ---- nix-darwin 本体 ----
if ! can_use_sudo; then
  warn "非対話環境で sudo を使えないため darwin-rebuild をスキップ"
  warn "必要なら対話ターミナルで実行: sudo darwin-rebuild switch --flake $DOTFILES_DIR/nix"
elif command -v darwin-rebuild >/dev/null; then
  log "darwin-rebuild は既に利用可能。通常の switch を実行"
  sudo darwin-rebuild switch --flake "$DOTFILES_DIR/nix"
else
  log "nix-darwin をブートストラップ"
  sudo nix --extra-experimental-features 'nix-command flakes' \
    run nix-darwin/master#darwin-rebuild -- \
    switch --flake "$DOTFILES_DIR/nix#$FLAKE_ATTR"
fi

# ---- symlinks ----
log "Nix 管理外ファイルの symlink 作成"
DOTFILES="$DOTFILES_DIR" bash "$DOTFILES_DIR/install.sh"

log "完了。新しいシェルを開いて以下で確認:"
cat <<'EOF'
  which darwin-rebuild          # /run/current-system/sw/bin/darwin-rebuild
  scutil --get LocalHostName    # kanade0404
  echo $SSH_AUTH_SOCK           # …/1password/t/agent.sock
  which brew mise rbenv         # 全部 path が出ればOK
EOF

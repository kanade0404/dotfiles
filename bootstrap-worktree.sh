#!/usr/bin/env bash
# bootstrap-worktree.sh - Apply this checkout/worktree as the active dotfiles.
#
# Use this from a git worktree when you want symlinks and nix-darwin to point at
# the worktree instead of the canonical ~/work/dotfiles checkout.

set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLAKE_ATTR="${FLAKE_ATTR:-kanade0404}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

can_use_sudo() {
  sudo -n true 2>/dev/null || [ -t 0 ]
}

[ "$(uname)" = "Darwin" ] \
  || die "bootstrap-worktree.sh は macOS 専用です。Linux/クラウド環境では 'DOTFILES=$DOTFILES_DIR bash install.sh' のみ実行してください"

command -v nix >/dev/null \
  || die "Nix が見つかりません。先に Determinate Nix をインストールしてください: https://determinate.systems/nix-installer/"

log "worktree を dotfiles 参照元として使用: $DOTFILES_DIR"

if [ -x /opt/homebrew/bin/brew ]; then
  log "Homebrew は既にインストール済み"
else
  log "Homebrew をインストール"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv)"

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

if ! can_use_sudo; then
  warn "非対話環境で sudo を使えないため darwin-rebuild をスキップ"
  warn "必要なら対話ターミナルで実行: sudo darwin-rebuild switch --flake $DOTFILES_DIR/nix"
elif command -v darwin-rebuild >/dev/null; then
  log "worktree の nix flake で darwin-rebuild switch を実行"
  sudo darwin-rebuild switch --flake "$DOTFILES_DIR/nix"
else
  log "nix-darwin を worktree の nix flake でブートストラップ"
  sudo nix --extra-experimental-features 'nix-command flakes' \
    run nix-darwin/master#darwin-rebuild -- \
    switch --flake "$DOTFILES_DIR/nix#$FLAKE_ATTR"
fi

log "worktree 内ファイルへの symlink を作成"
DOTFILES="$DOTFILES_DIR" bash "$DOTFILES_DIR/install.sh"

log "完了。現在の dotfiles 参照元:"
printf '  %s\n' "$DOTFILES_DIR"

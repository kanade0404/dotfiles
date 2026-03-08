#!/bin/bash
# install.sh - Symlink dotfiles NOT managed by home-manager
#
# home-manager handles: .zshrc, .gitconfig, tmux.conf, starship.toml, bat config, etc.
# This script handles: Neovim config (LazyVim), Ghostty, helper scripts, legacy files.

set -euo pipefail

DOTFILES="$HOME/work/dotfiles"

echo "==> Linking Neovim config (LazyVim, managed outside Nix)"
mkdir -p "$HOME/.config"
ln -sfn "$DOTFILES/.config/nvim" "$HOME/.config/nvim"

echo "==> Linking Ghostty config (no home-manager module)"
mkdir -p "$HOME/Library/Application Support/com.mitchellh.ghostty"
ln -sf "$DOTFILES/.config/ghostty/config" "$HOME/Library/Application Support/com.mitchellh.ghostty/config"

echo "==> Linking helper scripts"
mkdir -p "$HOME/.local/bin"
ln -sf "$DOTFILES/.local/bin/tmux-project" "$HOME/.local/bin/tmux-project"
ln -sf "$DOTFILES/.local/bin/gw" "$HOME/.local/bin/gw"

echo "==> Linking Claude Code user settings"
mkdir -p "$HOME/.claude"
ln -sf "$DOTFILES/.claude/settings.json" "$HOME/.claude/settings.json"
ln -sf "$DOTFILES/.claude/statusline-command.sh" "$HOME/.claude/statusline-command.sh"
# hooks: symlink each file (directory symlink would hide Claude's own hooks)
mkdir -p "$HOME/.claude/hooks"
for f in "$DOTFILES/.claude/hooks/"*; do
  [ -f "$f" ] && ln -sf "$f" "$HOME/.claude/hooks/$(basename "$f")"
done
# commands: symlink directory if it has content
if [ -d "$DOTFILES/.claude/commands" ] && [ "$(ls -A "$DOTFILES/.claude/commands" 2>/dev/null)" ]; then
  mkdir -p "$HOME/.claude/commands"
  for f in "$DOTFILES/.claude/commands/"*; do
    [ -f "$f" ] && ln -sf "$f" "$HOME/.claude/commands/$(basename "$f")"
  done
fi

echo "==> Linking legacy files"
ln -sf "$DOTFILES/.gitmessage" "$HOME/.gitmessage"
ln -sf "$DOTFILES/.gitignore" "$HOME/.gitignore"

echo "Done. Run 'sudo darwin-rebuild switch --flake ~/work/dotfiles/nix' for Nix-managed config."

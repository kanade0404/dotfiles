#!/bin/bash
# install.sh - Symlink dotfiles NOT managed by home-manager
#
# home-manager handles: .zshrc, .gitconfig, tmux.conf, starship.toml, bat config, etc.
# This script handles: Neovim config (LazyVim), Ghostty, helper scripts, legacy files.

set -euo pipefail

DOTFILES="$HOME/work/dotfiles"
OS="$(uname)"

echo "==> Linking Neovim config (LazyVim, managed outside Nix)"
mkdir -p "$HOME/.config"
ln -sfn "$DOTFILES/.config/nvim" "$HOME/.config/nvim"

if [ "$OS" = "Darwin" ]; then
  echo "==> Linking Ghostty config (no home-manager module)"
  mkdir -p "$HOME/Library/Application Support/com.mitchellh.ghostty"
  ln -sf "$DOTFILES/.config/ghostty/config" "$HOME/Library/Application Support/com.mitchellh.ghostty/config"
else
  echo "==> Skipping Ghostty config (non-macOS)"
fi

echo "==> Linking helper scripts"
mkdir -p "$HOME/.local/bin"
ln -sf "$DOTFILES/.local/bin/tmux-project" "$HOME/.local/bin/tmux-project"
ln -sf "$DOTFILES/.local/bin/gw" "$HOME/.local/bin/gw"

echo "==> Linking Codex user settings"
mkdir -p "$HOME/.codex"
ln -sf "$DOTFILES/.codex/config.toml" "$HOME/.codex/config.toml"
ln -sf "$DOTFILES/.codex/hooks.json" "$HOME/.codex/hooks.json"
# hooks: directory symlink だと Codex 自身の状態を隠すため、ファイル単位で symlink
mkdir -p "$HOME/.codex/hooks"
for f in "$DOTFILES/.codex/hooks/"*; do
  [ -f "$f" ] && ln -sf "$f" "$HOME/.codex/hooks/$(basename "$f")"
done
# hooks/lib: TypeScript modules を symlink
mkdir -p "$HOME/.codex/hooks/lib"
for f in "$DOTFILES/.codex/hooks/lib/"*; do
  [ -f "$f" ] && ln -sf "$f" "$HOME/.codex/hooks/lib/$(basename "$f")"
done
# commands: 内容がある場合のみ symlink
if [ -d "$DOTFILES/.codex/commands" ] && [ "$(ls -A "$DOTFILES/.codex/commands" 2>/dev/null)" ]; then
  mkdir -p "$HOME/.codex/commands"
  for f in "$DOTFILES/.codex/commands/"*; do
    [ -f "$f" ] && ln -sf "$f" "$HOME/.codex/commands/$(basename "$f")"
  done
fi

echo "==> Linking Claude Code user settings"
mkdir -p "$HOME/.claude"
ln -sf "$DOTFILES/.claude/settings.json" "$HOME/.claude/settings.json"
ln -sf "$DOTFILES/.claude/statusline.py" "$HOME/.claude/statusline.py"
# hooks: symlink each file to both ~/.claude/hooks/ and ~/.codex/hooks/
# (directory symlink would hide each tool's own hooks; .claude/hooks/ is the
#  single source of truth used by both Claude Code and Codex)
for target in "$HOME/.claude/hooks" "$HOME/.codex/hooks"; do
  mkdir -p "$target" "$target/lib"
  for f in "$DOTFILES/.claude/hooks/"*; do
    [ -f "$f" ] && ln -sf "$f" "$target/$(basename "$f")"
  done
  for f in "$DOTFILES/.claude/hooks/lib/"*; do
    [ -f "$f" ] && ln -sf "$f" "$target/lib/$(basename "$f")"
  done
done
# commands: symlink directory if it has content
if [ -d "$DOTFILES/.claude/commands" ] && [ "$(ls -A "$DOTFILES/.claude/commands" 2>/dev/null)" ]; then
  mkdir -p "$HOME/.claude/commands"
  for f in "$DOTFILES/.claude/commands/"*; do
    [ -f "$f" ] && ln -sf "$f" "$HOME/.claude/commands/$(basename "$f")"
  done
fi
# skills: symlink each skill directory (1 skill = 1 dir with SKILL.md + assets)
if [ -d "$DOTFILES/.claude/skills" ] && [ "$(ls -A "$DOTFILES/.claude/skills" 2>/dev/null)" ]; then
  mkdir -p "$HOME/.claude/skills"
  for d in "$DOTFILES/.claude/skills/"*/; do
    [ -d "$d" ] && ln -sfn "${d%/}" "$HOME/.claude/skills/$(basename "$d")"
  done
fi

echo "==> Linking legacy files"
ln -sf "$DOTFILES/.gitmessage" "$HOME/.gitmessage"
ln -sf "$DOTFILES/.gitignore" "$HOME/.gitignore"

if [ "$OS" = "Darwin" ]; then
  echo "Done. Run 'sudo darwin-rebuild switch --flake ~/work/dotfiles/nix' for Nix-managed config."
else
  echo "Done. (Nix-managed config is macOS-only and was skipped.)"
fi

#!/bin/bash
# install.sh - Install dotfiles NOT managed by home-manager
#
# home-manager handles: .zshrc, .gitconfig, tmux.conf, starship.toml, bat config, etc.
# This script handles: Neovim config (LazyVim), Ghostty, helper scripts, legacy files.

set -euo pipefail

DOTFILES="${DOTFILES:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
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

echo "==> Installing Codex user settings"
mkdir -p "$HOME/.codex"
# Replace an old symlink so Codex runtime writes stay in ~/.codex only.
# Re-running install.sh resets local Codex state such as project trust prompts.
rm -f "$HOME/.codex/config.toml"
install -m 600 "$DOTFILES/.codex/config.toml" "$HOME/.codex/config.toml"
ln -sf "$DOTFILES/.codex/hooks.json" "$HOME/.codex/hooks.json"
# rules: Codex execpolicy command permissions
if [ -d "$DOTFILES/.codex/rules" ] && [ "$(ls -A "$DOTFILES/.codex/rules" 2>/dev/null)" ]; then
  mkdir -p "$HOME/.codex/rules"
  for f in "$DOTFILES/.codex/rules/"*; do
    [ -f "$f" ] && ln -sf "$f" "$HOME/.codex/rules/$(basename "$f")"
  done
fi
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
# skills: .codex/skills から .agents/skills へ移行済みのため旧リンクを掃除する。
# .codex/skills は repo から削除され全て陳腐化するので、リンク先の存在に関わらず
# $DOTFILES/.codex/skills/ 配下を指す symlink は無条件で削除する。
if [ -d "$HOME/.codex/skills" ]; then
  for existing in "$HOME/.codex/skills/"*; do
    [ -L "$existing" ] || continue
    link_target="$(readlink "$existing")"
    case "$link_target" in
      "$DOTFILES/.codex/skills/"*)
        rm -f "$existing"
      ;;
    esac
  done
  rmdir "$HOME/.codex/skills" 2>/dev/null || true
fi
# skills: symlink each generated skill directory (1 skill = 1 dir with SKILL.md + assets)
# rulesync 9.1.1 は codexcli target の skills を .agents/skills (cwd相対) に出力し、
# Codex CLI 本体も project skills を .agents/skills から読むため、生成先をここに合わせる。
if [ -d "$HOME/.agents/skills" ]; then
  for existing in "$HOME/.agents/skills/"*; do
    [ -L "$existing" ] || continue
    link_target="$(readlink "$existing")"
    case "$link_target" in
      "$DOTFILES/.agents/skills/"*)
        [ -e "$link_target" ] || rm -f "$existing"
      ;;
    esac
  done
fi
if [ -d "$DOTFILES/.agents/skills" ] && [ "$(ls -A "$DOTFILES/.agents/skills" 2>/dev/null)" ]; then
  mkdir -p "$HOME/.agents/skills"
  for d in "$DOTFILES/.agents/skills/"*/; do
    if [ -d "$d" ]; then
      target="$HOME/.agents/skills/$(basename "$d")"
      if [ -e "$target" ] && [ ! -L "$target" ]; then
        echo "Error: $target exists and is not a symlink. Move it aside before re-running install.sh." >&2
        exit 1
      fi
      ln -sfn "${d%/}" "$target"
    fi
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
# scripts: symlink helper scripts (e.g. get-session-id.sh, compact-prep skill が使用)
if [ -d "$DOTFILES/.claude/scripts" ] && [ "$(ls -A "$DOTFILES/.claude/scripts" 2>/dev/null)" ]; then
  mkdir -p "$HOME/.claude/scripts"
  for f in "$DOTFILES/.claude/scripts/"*; do
    [ -f "$f" ] && ln -sf "$f" "$HOME/.claude/scripts/$(basename "$f")"
  done
fi
# commands: symlink directory if it has content
if [ -d "$DOTFILES/.claude/commands" ] && [ "$(ls -A "$DOTFILES/.claude/commands" 2>/dev/null)" ]; then
  mkdir -p "$HOME/.claude/commands"
  for f in "$DOTFILES/.claude/commands/"*; do
    [ -f "$f" ] && ln -sf "$f" "$HOME/.claude/commands/$(basename "$f")"
  done
fi
# skills: symlink each skill directory (1 skill = 1 dir with SKILL.md + assets)
if [ -d "$HOME/.claude/skills" ]; then
  for existing in "$HOME/.claude/skills/"*; do
    [ -L "$existing" ] || continue
    link_target="$(readlink "$existing")"
    case "$link_target" in
      "$DOTFILES/.claude/skills/"*)
        [ -e "$link_target" ] || rm -f "$existing"
      ;;
    esac
  done
fi
if [ -d "$DOTFILES/.claude/skills" ] && [ "$(ls -A "$DOTFILES/.claude/skills" 2>/dev/null)" ]; then
  mkdir -p "$HOME/.claude/skills"
  for d in "$DOTFILES/.claude/skills/"*/; do
    if [ -d "$d" ]; then
      target="$HOME/.claude/skills/$(basename "$d")"
      if [ -e "$target" ] && [ ! -L "$target" ]; then
        echo "Error: $target exists and is not a symlink. Move it aside before re-running install.sh." >&2
        exit 1
      fi
      ln -sfn "${d%/}" "$target"
    fi
  done
fi

echo "==> Linking OpenCode user settings"
# opencode は ~/.config/opencode/ を global config として読む。
# skills は ~/.config/opencode/skills/<name>/SKILL.md を探索する (project の
# .opencode/skills/ と .agents/skills/ 、~/.claude/skills/ も fallback で読む)。
# rulesync で生成した .opencode/skills/ を global へ symlink し、どの cwd でも
# フルセットが使えるようにする。
if [ -d "$HOME/.config/opencode/skills" ]; then
  for existing in "$HOME/.config/opencode/skills/"*; do
    [ -L "$existing" ] || continue
    link_target="$(readlink "$existing")"
    case "$link_target" in
      "$DOTFILES/.opencode/skills/"*)
        [ -e "$link_target" ] || rm -f "$existing"
      ;;
    esac
  done
fi
if [ -d "$DOTFILES/.opencode/skills" ] && [ "$(ls -A "$DOTFILES/.opencode/skills" 2>/dev/null)" ]; then
  mkdir -p "$HOME/.config/opencode/skills"
  for d in "$DOTFILES/.opencode/skills/"*/; do
    if [ -d "$d" ]; then
      target="$HOME/.config/opencode/skills/$(basename "$d")"
      if [ -e "$target" ] && [ ! -L "$target" ]; then
        echo "Error: $target exists and is not a symlink. Move it aside before re-running install.sh." >&2
        exit 1
      fi
      ln -sfn "${d%/}" "$target"
    fi
  done
fi

echo "==> Installing git hooks (lefthook)"
if command -v lefthook >/dev/null 2>&1 && [ -d "$DOTFILES/.git" ]; then
  (cd "$DOTFILES" && lefthook install)
else
  echo "    skipped (lefthook not found or not a git repo)"
fi

echo "==> Linking legacy files"
ln -sf "$DOTFILES/.gitmessage" "$HOME/.gitmessage"
ln -sf "$DOTFILES/.gitignore" "$HOME/.gitignore"

if [ "$OS" = "Darwin" ]; then
  echo "Done. Run 'sudo darwin-rebuild switch --flake $DOTFILES/nix' for Nix-managed config."
else
  echo "Done. (Nix-managed config is macOS-only and was skipped.)"
fi

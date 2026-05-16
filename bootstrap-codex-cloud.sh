#!/usr/bin/env bash
# bootstrap-codex-cloud.sh - Set up this repository in Codex Cloud.
#
# This intentionally avoids macOS-only setup, sudo, nix-darwin, Homebrew, and
# dotfile symlinks. Codex Cloud only needs the project toolchain for tests.

set -euo pipefail

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

BUN_MIN_VERSION="${BUN_MIN_VERSION:-1.3.0}"

find_project_dir() {
  if [ -n "${PROJECT_DIR:-}" ] && [ -f "$PROJECT_DIR/package.json" ]; then
    printf '%s\n' "$PROJECT_DIR"
    return
  elif [ -n "${PROJECT_DIR:-}" ]; then
    warn "Ignoring PROJECT_DIR without package.json: $PROJECT_DIR"
  fi

  if [ -f package.json ]; then
    pwd
    return
  fi

  if git_root="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -f "$git_root/package.json" ]; then
    printf '%s\n' "$git_root"
    return
  fi

  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$script_dir/package.json" ]; then
    printf '%s\n' "$script_dir"
    return
  fi

  die "Could not find project root with package.json. Run this script from the repository checkout or set PROJECT_DIR."
}

version_at_least() {
  current="$1"
  minimum="$2"

  current_major="${current%%.*}"
  rest="${current#*.}"
  current_minor="${rest%%.*}"
  rest="${rest#*.}"
  current_patch="${rest%%[^0-9]*}"

  minimum_major="${minimum%%.*}"
  rest="${minimum#*.}"
  minimum_minor="${rest%%.*}"
  rest="${rest#*.}"
  minimum_patch="${rest%%[^0-9]*}"

  current_patch="${current_patch:-0}"
  minimum_patch="${minimum_patch:-0}"

  [ "$current_major" -gt "$minimum_major" ] && return 0
  [ "$current_major" -lt "$minimum_major" ] && return 1
  [ "$current_minor" -gt "$minimum_minor" ] && return 0
  [ "$current_minor" -lt "$minimum_minor" ] && return 1
  [ "$current_patch" -ge "$minimum_patch" ]
}

install_bun() {
  command -v curl >/dev/null \
    || die "Bun is not installed or is too old, and curl is not available"

  log "Installing Bun into user home"
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$BUN_INSTALL/bin:$PATH"

  command -v bun >/dev/null \
    || die "Bun installation completed but bun was not found on PATH"

  log "Bun installed: $(bun --version)"
}

ensure_bun() {
  if command -v bun >/dev/null; then
    bun_version="$(bun --version)"
    if version_at_least "$bun_version" "$BUN_MIN_VERSION"; then
      log "Bun is already available: $bun_version"
      return
    fi

    warn "Bun $bun_version is older than required $BUN_MIN_VERSION"
  fi

  install_bun
  bun_version="$(bun --version)"
  if ! version_at_least "$bun_version" "$BUN_MIN_VERSION"; then
    die "Installed Bun $bun_version is still older than required $BUN_MIN_VERSION"
  fi
  log "Bun is available: $bun_version"
}

PROJECT_DIR="$(find_project_dir)"
cd "$PROJECT_DIR"
log "Project directory: $PROJECT_DIR"

case "$(uname)" in
  Linux)
    log "Codex Cloud/Linux setup"
    ;;
  Darwin)
    warn "Running cloud setup on macOS; system dotfiles setup is intentionally skipped"
    ;;
  *)
    warn "Unknown OS: $(uname). Continuing with project-only setup"
    ;;
esac

ensure_bun

if [ -f bun.lockb ] || [ -f bun.lock ]; then
  log "Installing dependencies with frozen lockfile"
  bun install --frozen-lockfile
else
  log "Installing dependencies"
  bun install
fi

if [ "${RUN_TESTS:-0}" = "1" ]; then
  log "Running tests"
  bun test
else
  log "Skipping tests. Set RUN_TESTS=1 to run bun test during setup"
fi

log "Codex Cloud setup complete"

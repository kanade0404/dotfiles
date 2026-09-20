#!/bin/bash
# install.sh - Install dotfiles NOT managed by home-manager
#
# home-manager handles: .zshrc, .gitconfig, tmux.conf, starship.toml, bat config, etc.
# This script handles: Neovim config (LazyVim), Ghostty, helper scripts, legacy files.

set -euo pipefail

DOTFILES="${DOTFILES:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
OS="$(uname)"
codex_config_backup=""
codex_config_backup_retained=""
codex_config_backup_done=""
codex_config_backup_kept=""
managed_file_temps=()

cleanup_codex_config_backup() {
  if [ -n "${codex_config_backup:-}" ]; then
    rm -f "$codex_config_backup"
  fi
  # 「窓が閉じたので消す」と決めたパス。変数クリアと `rm` の間で中断しても
  # token 入りのコピーが残らないよう、掃除側でも冪等に消す。
  if [ -n "${codex_config_backup_done:-}" ]; then
    rm -f "$codex_config_backup_done"
  fi
}

cleanup_managed_file_temps() {
  local tmp

  # macOS 既定の /bin/bash (3.2) は空配列の "${a[@]}" を set -u で unbound 扱いに
  # するため、要素数で先に抜ける。`[ ... ] && rm` 形式にすると最終評価が 1 になり
  # trap が非ゼロで返りうるので、素直に if/for で書く。
  if [ "${#managed_file_temps[@]}" -gt 0 ]; then
    for tmp in "${managed_file_temps[@]}"; do
      rm -f "$tmp"
    done
  fi
  return 0
}

cleanup_install() {
  cleanup_codex_config_backup
  cleanup_managed_file_temps
}

# EXIT trap は untrapped fatal signal (SIGHUP/SIGINT/SIGQUIT/SIGTERM) では走らないため、
# 中断すると `settings.json.tmp.XXXXXX` 等が `$HOME` に残る (配列はプロセス内にしか
# 無いので次回実行でも掃除されない)。signal 側は掃除してから明示的に exit する。
# `cleanup_install` の中身は `rm -f` だけで冪等なので、exit 後の EXIT trap で
# 二重に走っても問題ない。
#
# exit code は慣例どおり 128 + signum にして、通常の install 失敗 (exit 1) と
# 中断を呼び出し元 (bootstrap.sh 等) から区別できるようにする。
#
# ただし codex config のバックアップは **消さない**。`~/.codex/config.toml` を template で
# 置換してから `codex-otel --write-config-only` が Authorization を書き戻すまでの窓で
# 中断すると、このバックアップが旧 config の唯一のコピーになる。場所を知らせたうえで
# 変数を空にし、後続の EXIT trap (`cleanup_codex_config_backup`) にも消させない
# (`.bak` 側の「退避が取れないなら上書きしない」規律と揃える)。
cleanup_install_and_exit() {
  local signum="$1"
  local kept="${codex_config_backup:-}"

  # クリアは **echo より先**。SIGHUP は端末消失時に届くので fd 2 への write が EIO で
  # 失敗しうる。`set -e` は trap 本体にも効くため、echo を先に置くとその失敗で
  # クリア前に exit(1) し、EXIT trap がバックアップを消してしまう
  # (exit code も 128+signum でなくなる)。echo 自体にも `|| true` を付ける。
  codex_config_backup=""
  if [ -n "${codex_config_backup_done:-}" ]; then
    rm -f "$codex_config_backup_done"
    # `_done` への代入とクリアの間で signal を受けると両者が同じパスを指す。
    # いま消したばかりのパスを "kept" として案内しない。
    if [ "$kept" = "$codex_config_backup_done" ]; then
      kept=""
    fi
  fi
  if [ -n "$kept" ]; then
    echo "note: interrupted; previous Codex config backup kept at $kept" >&2 || true
  fi
  cleanup_managed_file_temps
  exit "$((128 + signum))"
}

# Install a dotfiles file as a real file (not a symlink) so that local agent
# runtimes (Orca 等) の書き込みが git 管理下の実体まで届かないようにする。
#
# `rm -f dest && install src dest` にはしない: source が無い場合に
# 「dest を消してから install が失敗 → set -e で abort」となり、
# 以降の処理が一切走らないまま既存設定だけが失われる。
# temp へ install してから mv (rename(2)) で差し替えることで
#   - source 不在なら install が失敗するが dest は無傷
#   - symlink でも実体でもアトミックに置き換わる
# を両立する。
#
# 第 4 引数に `backup` を渡すと、置き換え直前の dest を `backup_local_settings` で
# 1 世代だけ退避する。退避を**呼び出し側ではなく関数内**でやるのは順序のため:
# source の staging (`install`) に失敗する経路で先に退避してしまうと、dest は無傷でも
# 既存の `<dest>.bak` (= 巻き戻りからの復旧手段) を潰してしまう。
install_managed_file() {
  local mode="$1" src="$2" dest="$3" backup="${4:-}"
  local tmp

  # 第 4 引数は stringly-typed なので、typo が黙って「退避なし」に落ちないよう
  # 未知の値は失敗させる (安全性を呼び出し文脈に委ねない方針の一環)。
  # 引数の検証は mktemp / install の副作用より**前**に済ませ、失敗パスを
  # 「何もしていない状態からの return 1」に保つ。
  case "$backup" in
    backup | "") ;;
    *)
      echo "error: unknown backup flag '$backup' for $dest" >&2
      return 1
      ;;
  esac

  # dest が directory (または directory への symlink) だと `mv -f` は置き換えではなく
  # 「tmp を dest の中へ移動」になり 0 を返す = 置き換わっていないのに成功してしまう。
  # 安全性を呼び出し文脈に委ねない方針に揃えて、関数側で先に弾く。
  if [ -d "$dest" ]; then
    echo "error: $dest is a directory; refusing to install" >&2
    return 1
  fi

  # 残余リスク: `mktemp` が返ってから次行の配列 append までの極小窓で signal を受けると、
  # trap は配列しか見ないのでこの temp だけ掃除から漏れる (stray file 1 個)。
  # glob ベースの掃除にすれば塞げるが、複雑さに見合わないので受容する。
  tmp="$(mktemp "$dest.tmp.XXXXXX")" || return 1
  managed_file_temps+=("$tmp")
  # install の失敗は **必ず** この場で `return 1` すること。`install` と `mv` を単に
  # 行で並べると、呼び出し側の errexit が抑止された文脈 (`f || warn` / `if ! f` /
  # `&&` の右辺) では install の失敗後も次行が走り、mktemp が作った空ファイルを dest に
  # 被せたうえで 0 を返してしまう。安全性を呼び出し文脈ではなく関数内に閉じる。
  install -m "$mode" "$src" "$tmp" || return 1
  if [ "$backup" = "backup" ]; then
    backup_local_settings "$dest" "$tmp" || return 1
  fi
  mv -f "$tmp" "$dest" || return 1
}

# install.sh の再実行は dest を dotfiles の内容へ巻き戻すため、ローカルに溜まった設定
# (`/permissions` で追加した allow/deny、`/model` の選択など) が失われる。取り戻せるよう
# 直前の内容を 1 世代だけ `<dest>.bak` に退避する。世代を増やさないので溜まらない。
#
# `.codex/config.toml` は対象外: Authorization の引き継ぎを
# `CODEX_OTEL_PRESERVE_AUTH_FROM` で別途持っており、bearer token の平文コピーを
# `$HOME` に増やしたくないため。
#
# 退避に失敗したら **非ゼロを返して置き換えを中止する**。退避の存在理由は
# 「巻き戻りからの復旧」なので、それが取れない状態で dest を上書きすると、
# 保険が最も必要な瞬間に限ってローカル設定の唯一のコピーが不可逆に失われる。
# 中止時点で dest は無傷なので、原因を直して再実行すればよい
# (source 不在時に `return 1` する経路と同じ扱い)。
# 第 2 引数は staging 済みの新しい内容 (install_managed_file の temp)。
backup_local_settings() {
  local dest="$1" staged="$2"
  local bak_tmp

  [ -f "$dest" ] || return 0
  # ローカル差分が無いなら退避しても情報が増えず、以前の意味ある退避を
  # dotfiles と同一の内容で潰すだけなので何もしない。
  if cmp -s "$dest" "$staged"; then
    return 0
  fi
  # `.bak` が directory だと `cp` は「中へコピー」、symlink だとリンク先へ書き込みになり、
  # 「`<dest>.bak` から手で戻せる」契約が黙って破れる (`install_managed_file` の
  # `[ -d "$dest" ]` ガードと同じ趣旨)。
  if [ -L "$dest.bak" ] || { [ -e "$dest.bak" ] && [ ! -f "$dest.bak" ]; }; then
    echo "error: $dest.bak is not a regular file; refusing to overwrite $dest without a backup" >&2
    return 1
  fi
  # `cp` は出力先を O_TRUNC で開くため、既存の `.bak` へ直接書くと書き込み開始時点で
  # 旧内容が失われる。途中で失敗 (ENOSPC 等) すると唯一の復旧コピーが壊れた断片に化け、
  # そのまま `mv -f` で dest も巻き戻って復旧手段が消える。dest 側と同じ規律で
  # temp へ取ってから rename(2) で差し替える。
  bak_tmp="$(mktemp "$dest.bak.tmp.XXXXXX")" || {
    echo "error: failed to back up $dest; refusing to overwrite it" >&2
    return 1
  }
  managed_file_temps+=("$bak_tmp")
  if cp -p "$dest" "$bak_tmp" && mv -f "$bak_tmp" "$dest.bak"; then
    return 0
  fi
  echo "error: failed to back up $dest; refusing to overwrite it" >&2
  return 1
}

# 失敗しても **errexit で abort させない** (`|| return 1` を明示する)。ここは
# 「codex-otel が失敗した直後 = dest は template 置換済みで Authorization 未復元、
# `${TMPDIR:-/tmp}` のバックアップが旧 config の唯一のコピー」という瞬間で、abort すると
# EXIT trap がそのコピーを消してしまう (`backup_local_settings` / signal trap と同じ
# 「退避が取れないなら唯一のコピーを消さない」規律)。
retain_codex_config_backup() {
  local retained_backup

  [ -n "${codex_config_backup:-}" ] || return 0
  retained_backup="$(mktemp "$HOME/.codex/config.toml.bak.XXXXXX")" || return 1
  if ! mv "$codex_config_backup" "$retained_backup"; then
    rm -f "$retained_backup"
    return 1
  fi
  codex_config_backup=""
  codex_config_backup_retained="$retained_backup"
}

trap cleanup_install EXIT
trap 'cleanup_install_and_exit 1' HUP
trap 'cleanup_install_and_exit 2' INT
trap 'cleanup_install_and_exit 3' QUIT
trap 'cleanup_install_and_exit 15' TERM

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
ln -sf "$DOTFILES/.local/bin/codex-otel" "$HOME/.local/bin/codex-otel"

echo "==> Installing Codex user settings"
mkdir -p "$HOME/.codex"
# Replace an old symlink so Codex runtime writes stay in ~/.codex only.
# Re-running install.sh resets local Codex state such as project trust prompts.
if [ -f "$HOME/.codex/config.toml" ]; then
  # 残余リスク: 変数が非空になってから `cp` が終わるまでの窓で signal を受けると、
  # trap は空 (または部分) コピーを "backup kept at ..." として案内する。この窓では
  # dest 自体が無傷なのでデータは失われないが、案内されたパスの中身が旧 config とは
  # 限らない。install_managed_file の mktemp→staging 窓と同クラスとして受容する。
  codex_config_backup="$(mktemp "${TMPDIR:-/tmp}/codex-config.XXXXXX")"
  cp "$HOME/.codex/config.toml" "$codex_config_backup"
fi
install_managed_file 600 "$DOTFILES/.codex/config.toml" "$HOME/.codex/config.toml"
if ! CODEX_OTEL_CONFIG_TARGET="$HOME/.codex/config.toml" CODEX_OTEL_PRESERVE_AUTH_FROM="$codex_config_backup" "$DOTFILES/.local/bin/codex-otel" --write-config-only; then
  if ! retain_codex_config_backup && [ -n "$codex_config_backup" ]; then
    # 退避先へ移せなかった。唯一のコピーなので EXIT trap にも消させず、場所を知らせる
    # (クリアを echo より先に置く理由は cleanup_install_and_exit と同じ)。
    codex_config_backup_kept="$codex_config_backup"
    codex_config_backup=""
    echo "warning: failed to move the previous Codex config backup into ~/.codex;" \
      "keeping it at $codex_config_backup_kept" >&2 || true
  fi
  echo "warning: failed to refresh Codex OTEL config; continuing install.sh" >&2
  if [ -n "$codex_config_backup_retained" ]; then
    echo "warning: retained previous Codex config backup at $codex_config_backup_retained" >&2
  fi
fi
# ここで「backup が旧 config の唯一のコピー」である窓は閉じる (Authorization は
# 書き戻し済み、失敗時は retain 済み)。窓の外で中断したときに bearer token を平文で
# 含むコピーが `${TMPDIR:-/tmp}` へ残らないよう、明示的に掃除して signal trap の
# 保持対象からも外す。
# **先に変数を空にしてから消す**。逆順だと `rm` と変数クリアの間で signal を受けたときに、
# trap が既に消えたパスを "backup kept at ..." と案内してしまう。
codex_config_backup_done="$codex_config_backup"
codex_config_backup=""
if [ -n "$codex_config_backup_done" ]; then
  rm -f "$codex_config_backup_done"
fi
# Replace an old symlink so Orca/agent runtime writes stay in ~/.codex only.
# Re-running install.sh resets local hook registrations (Orca re-injects on next pane).
install_managed_file 644 "$DOTFILES/.codex/hooks.json" "$HOME/.codex/hooks.json" backup
# herdr の Codex 連携スクリプト。hooks.json が $HOME/.codex/ 直下を指しており、
# かつ .claude/hooks/* は ~/.codex/hooks/ にも配布される (同名だと Claude 版に
# 上書きされる) ため、hooks/ ではなく .codex/ 直下へ個別に symlink する。
# なお ~/.codex/hooks/ には Claude 用スクリプト (herdr-agent-state.sh の Claude 版や
# otel-headers.sh 等) がそのまま残るが、Codex はそれらを参照しないので無害。
ln -sf "$DOTFILES/.codex/herdr-agent-state.sh" "$HOME/.codex/herdr-agent-state.sh"
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

echo "==> Installing Claude Code user settings"
mkdir -p "$HOME/.claude"
# Replace an old symlink so Orca/agent runtime writes stay in ~/.claude only
# (same rationale as the ~/.codex/hooks.json replacement above).
install_managed_file 644 "$DOTFILES/.claude/settings.json" "$HOME/.claude/settings.json" backup
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
# skills: project (各 repo の .claude/skills) を正とする方針のため、
# ~/.claude/skills へのグローバル symlink 配布はしない。
# 各 repo は rulesync fetch (kanade0404/skills を @<tag> で固定取得) で
# 自分の .claude/skills/ を用意する。
# 旧バージョンの install.sh が作成した ~/.claude/skills 配下の symlink は
# 陳腐化するので、リンク先の存在に関わらず無条件で削除する
# (.codex/skills → .agents/skills 移行時の掃除ブロックと同型)。
if [ -d "$HOME/.claude/skills" ]; then
  for existing in "$HOME/.claude/skills/"*; do
    [ -L "$existing" ] || continue
    link_target="$(readlink "$existing")"
    case "$link_target" in
      "$DOTFILES/.claude/skills/"*)
        rm -f "$existing"
      ;;
    esac
  done
  rmdir "$HOME/.claude/skills" 2>/dev/null || true
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

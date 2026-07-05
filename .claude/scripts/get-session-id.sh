#!/bin/bash
# 現在の Claude Code セッションの session_id を推定して stdout に出力する。
#
# 仕組み:
#   statusline.py が毎ターン ${TMPDIR}/claude-session-id/<session_id> に
#   その時点の cwd を 1 行で書き出す。skill 内の Bash はセッションの cwd で
#   実行されるため、呼び出し元 cwd と一致し、かつ最も新しく更新された
#   ポインタの session_id が現セッションのものとみなせる。
#
# 引数:
#   $1  比較対象の cwd（省略時は $PWD）
# 出力:
#   成功: session_id を 1 行出力し exit 0
#   失敗: 何も出力せず exit 1（compact-prep skill 側で「取得不能」として停止）
#
# 注: 同一 cwd で複数セッションを並走させた場合、最後に statusline が更新した
#     セッションを返す（mtime 最新を採用）。単一セッション運用では一意に定まる。

set -uo pipefail

target="${1:-$PWD}"
dir="${TMPDIR:-/tmp}/claude-session-id"

[[ -d "$dir" ]] || exit 1

# ls -t で mtime 降順（新しい順）に走査し、内容(cwd)が一致する最初の
# ポインタの session_id を返す。stat/date -r の BSD/GNU 差異を避けるため
# ls -t でソートする。
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  f="$dir/$name"
  [[ -f "$f" ]] || continue
  content=$(cat "$f" 2>/dev/null) || continue
  if [[ "$content" == "$target" ]]; then
    printf '%s\n' "$name"
    exit 0
  fi
done < <(ls -t "$dir" 2>/dev/null)

exit 1

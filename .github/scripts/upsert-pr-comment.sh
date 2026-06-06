#!/usr/bin/env bash
#
# upsert-pr-comment.sh
#
# 隠しマーカーで識別した PR コメントを 1 件だけ維持する (upsert)。
# マーカーを含む既存コメントがあれば PATCH で更新し、無ければ POST で新規作成する。
# これにより「サマリ(総評)は同じコメントを更新し続ける」を決定的に実現する。
#
# claude-code-action の use_sticky_comment は claude[bot] 認証専用で、
# github_token (= github-actions[bot]) を渡す構成 (OIDC 401 回避のため必須) では
# 効かないため、その代替として本スクリプトを使う。
#
# 使い方:
#   upsert-pr-comment.sh <body-file>
#
# 必須環境変数:
#   GH_TOKEN    gh CLI 用トークン (= secrets.GITHUB_TOKEN)
#   REPO        owner/name 形式のリポジトリ slug
#   PR_NUMBER   対象 PR 番号
# 任意環境変数:
#   MARKER      コメント識別用の隠しマーカー
#               (既定: <!-- claude-code-review:summary -->)
#
# 挙動:
#   - body-file が存在しない/空のときは何もせず正常終了する
#     (レビューが失敗した場合などにサマリを消さない / 誤投稿しないため)。
#   - body-file にマーカーが無ければ先頭へ自動付与する。

set -euo pipefail

readonly body_file="${1:-}"
readonly marker="${MARKER:-<!-- claude-code-review:summary -->}"

if [[ -z "${body_file}" ]]; then
  echo "usage: $0 <body-file>" >&2
  exit 2
fi

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REPO:?REPO is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"

if [[ ! -s "${body_file}" ]]; then
  echo "No summary body at '${body_file}' (missing or empty); skipping upsert."
  exit 0
fi

# マーカーを含んだ最終的な本文を一時ファイルへ用意する。
work_file="$(mktemp)"
trap 'rm -f "${work_file}"' EXIT

if grep -qF "${marker}" "${body_file}"; then
  cp "${body_file}" "${work_file}"
else
  {
    printf '%s\n\n' "${marker}"
    cat "${body_file}"
  } >"${work_file}"
fi

# マーカーを含む既存コメント ID を探す (最初の 1 件)。
# 注意: `gh api --paginate --jq FILTER` は各ページの JSON 配列に対して
# 独立に jq を適用するため、複数ページにマーカーコメントがあると複数 ID が
# 出力されてしまう。--slurp で全ページを 1 つの配列 (= [[page1...],[page2...]])
# に連結し、それを standalone jq へパイプして flatten・確実に 1 件へ絞る。
# (--slurp は --jq/--template と併用不可のため jq へパイプする)
existing_id="$(
  gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" --paginate --slurp \
    | jq -r "[.[][] | select(.body | contains(\"${marker}\"))] | .[0].id // empty"
)"

if [[ -n "${existing_id}" ]]; then
  gh api --method PATCH \
    "repos/${REPO}/issues/comments/${existing_id}" \
    -F "body=@${work_file}" >/dev/null
  echo "Updated existing summary comment (id=${existing_id})."
else
  gh api --method POST \
    "repos/${REPO}/issues/${PR_NUMBER}/comments" \
    -F "body=@${work_file}" >/dev/null
  echo "Created new summary comment."
fi

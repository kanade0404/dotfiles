#!/bin/bash
# PermissionRequest hook: auto-approve safe Bash commands
# permissions.allow でマッチしなかったコマンドをここで判定する
# 安全なら allow を返し、不明なら出力なし（通常の承認ダイアログに委ねる）

set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

[ -z "$command" ] && exit 0

# コマンドの先頭部分を取得（&& や ; で連結されていても最初のコマンドで判定）
first_command=$(echo "$command" | head -1 | sed 's/^[[:space:]]*//')

# 安全なコマンドパターン
safe_patterns=(
  # git
  '^git (status|diff|log|show|branch|stash|add|commit|push|fetch|pull|switch|merge|worktree|restore|cherry-pick|tag|remote|rev-parse|symbolic-ref)'
  # gh CLI
  '^gh (pr|issue|run|workflow|api|repo view)'
  # pnpm
  '^pnpm '
  # npm (read-only)
  '^npm (run|test|exec|ls|list|info|view|outdated|audit) '
  # docker compose
  '^docker compose '
  '^docker-compose '
  # task runner
  '^task '
  # 読み取り系コマンド
  '^(wc|head|tail|which|file|tree|pwd|realpath|basename|dirname|stat|du|jq|sort|uniq|cut|tr|grep|rg|type|whoami|uname|date)( |$)'
)

for pattern in "${safe_patterns[@]}"; do
  if echo "$first_command" | grep -qE "$pattern"; then
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
  fi
done

# マッチしない場合は出力なし → 通常の承認ダイアログ
exit 0

#!/bin/sh
# Claude Code status line - inspired by Starship prompt configuration

input=$(cat)

# Extract data from JSON input
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd')
model=$(echo "$input" | jq -r '.model.display_name // empty')
session_id=$(echo "$input" | jq -r '.session_id // empty')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
ctx_limit=$(echo "$input" | jq -r '.context_window.context_window_size // empty')
total_in=$(echo "$input" | jq -r '.context_window.total_input_tokens // empty')
total_out=$(echo "$input" | jq -r '.context_window.total_output_tokens // empty')

# Helper: format number as Xk (e.g. 12345 -> 12.3k, 200000 -> 200k)
fmt_k() {
  echo "$1" | awk '{
    if ($1 >= 1000) {
      val = $1 / 1000
      if (val == int(val)) {
        printf "%dk", val
      } else {
        printf "%.1fk", val
      }
    } else {
      printf "%d", $1
    }
  }'
}

# Shorten directory path (up to 3 components, like Starship truncation_length=3)
short_dir=$(echo "$cwd" | awk -F/ '{
  n = NF
  if (n <= 3) {
    print $0
  } else {
    print "..." "/" $(n-2) "/" $(n-1) "/" $n
  }
}')
# Replace $HOME with ~
home="$HOME"
short_dir=$(echo "$short_dir" | sed "s|^$home|~|")

# Git info (skip lock to avoid conflicts)
git_branch=""
git_dirty=""
if git -C "$cwd" rev-parse --git-dir > /dev/null 2>&1; then
  git_branch=$(git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null || git -C "$cwd" rev-parse --short HEAD 2>/dev/null)
  git_status=$(git -C "$cwd" status --porcelain 2>/dev/null)
  if [ -n "$git_status" ]; then
    git_dirty="*"
  fi
fi

# Build status line parts

# Directory
parts="${short_dir}"

# Git branch with nerd font symbol (matching Starship config)
if [ -n "$git_branch" ]; then
  parts="${parts}  ${git_branch}${git_dirty}"
fi

# Model name
if [ -n "$model" ]; then
  parts="${parts} | ${model}"
fi

# Session ID (first 8 characters)
if [ -n "$session_id" ]; then
  short_id=$(echo "$session_id" | cut -c1-8)
  parts="${parts} | id:${short_id}"
fi

# Context window limit
if [ -n "$ctx_limit" ]; then
  limit_fmt=$(fmt_k "$ctx_limit")
  parts="${parts} | limit:${limit_fmt}"
fi

# Token usage (input / output)
if [ -n "$total_in" ] && [ -n "$total_out" ]; then
  in_fmt=$(fmt_k "$total_in")
  out_fmt=$(fmt_k "$total_out")
  parts="${parts} | in:${in_fmt} out:${out_fmt}"
fi

# Context usage percentage
if [ -n "$used_pct" ]; then
  used_int=$(printf "%.0f" "$used_pct" 2>/dev/null || echo "$used_pct" | cut -d. -f1)
  parts="${parts} | ctx:${used_int}%"
fi

printf "%s" "$parts"

#!/usr/bin/env bash
set -e
msg=$(cat ~/.claude/.last_prompt | head -c 72)
git add -A
git commit -m "$msg"

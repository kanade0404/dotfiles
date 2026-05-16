#!/usr/bin/env bash
set -e
msg=$(head -c 72 ~/.claude/.last_prompt)
git add -A
git commit -m "$msg"

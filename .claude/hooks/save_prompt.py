#!/usr/bin/env python3
import json, sys, os, textwrap, re
data = json.load(sys.stdin)
prompt = (data.get("message") or {}).get("content", "")
with open(os.path.expanduser("~/.claude/.last_prompt"), "w") as f:
    f.write(re.sub(r"\s+", " ", prompt.strip()))

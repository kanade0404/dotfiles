#!/usr/bin/env python3
"""Claude Code statusline with braille progress bars"""
import json, sys, subprocess, os

data = json.load(sys.stdin)

BRAILLE = ' ⣀⣄⣤⣦⣶⣷⣿'
R = '\033[0m'
DIM = '\033[2m'


def gradient(pct):
    if pct < 50:
        r = int(pct * 5.1)
        return f'\033[38;2;{r};200;80m'
    else:
        g = int(200 - (pct - 50) * 4)
        return f'\033[38;2;255;{max(g, 0)};60m'


def braille_bar(pct, width=8):
    pct = min(max(pct, 0), 100)
    level = pct / 100
    bar = ''
    for i in range(width):
        seg_start = i / width
        seg_end = (i + 1) / width
        if level >= seg_end:
            bar += BRAILLE[7]
        elif level <= seg_start:
            bar += BRAILLE[0]
        else:
            frac = (level - seg_start) / (seg_end - seg_start)
            bar += BRAILLE[1 + min(int(frac * 7), 6)]
    return bar


def fmt(label, pct):
    p = round(pct)
    return f'{DIM}{label}{R} {gradient(pct)}{braille_bar(pct)}{R} {p}%'


def short_dir(cwd):
    home = os.path.expanduser('~')
    path = cwd.replace(home, '~', 1) if cwd.startswith(home) else cwd
    parts = path.split('/')
    if len(parts) > 3:
        return '.../' + '/'.join(parts[-3:])
    return path


def git_info(cwd):
    try:
        branch = subprocess.run(
            ['git', '-C', cwd, 'symbolic-ref', '--short', 'HEAD'],
            capture_output=True, text=True, timeout=2
        )
        if branch.returncode != 0:
            branch = subprocess.run(
                ['git', '-C', cwd, 'rev-parse', '--short', 'HEAD'],
                capture_output=True, text=True, timeout=2
            )
        if branch.returncode != 0:
            return None
        name = branch.stdout.strip()
        status = subprocess.run(
            ['git', '-C', cwd, 'status', '--porcelain'],
            capture_output=True, text=True, timeout=2
        )
        dirty = '*' if status.stdout.strip() else ''
        return f' {name}{dirty}'
    except Exception:
        return None


SEP = f' {DIM}|{R} '
parts = []

# Directory
cwd = data.get('workspace', {}).get('current_dir') or data.get('cwd', '')
if cwd:
    parts.append(short_dir(cwd))

# Git branch
git = git_info(cwd) if cwd else None
if git:
    parts.append(git)

# Context usage (left side for visibility)
ctx = data.get('context_window', {}).get('used_percentage')
if ctx is not None:
    parts.append(fmt('ctx', ctx))

# Model name
model = data.get('model', {}).get('display_name')
if model:
    parts.append(model)

# Rate limits (5h / 7d)
five = data.get('rate_limits', {}).get('five_hour', {}).get('used_percentage')
if five is not None:
    parts.append(fmt('5h', five))

week = data.get('rate_limits', {}).get('seven_day', {}).get('used_percentage')
if week is not None:
    parts.append(fmt('7d', week))

print(SEP.join(parts), end='')

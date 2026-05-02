#!/usr/bin/env python3
"""Status line: model | branch | ctx bar | 5h bar | 7d bar | dir"""
import json, sys, os, re, shutil, subprocess

ANSI_RE = re.compile(r'\033\[[0-9;]*m')

def visible_len(s):
    return len(ANSI_RE.sub('', s))

data = json.load(sys.stdin)

R = '\033[0m'
DIM = '\033[38;2;110;110;110m'
SEP = '\033[38;2;160;160;160m'
TRACK = '\033[38;2;200;200;200m'
MODEL_COLOR = '\033[38;2;180;120;220m'
BRANCH_COLOR = '\033[38;2;88;166;255m'
DIRTY_COLOR = '\033[38;2;220;160;60m'

def gradient(pct):
    if pct < 50:
        r = int(pct * 5.1)
        return f'\033[38;2;{r};200;80m'
    else:
        g = int(200 - (pct - 50) * 4)
        return f'\033[38;2;255;{max(g, 0)};60m'

BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

def hbar(pct, width=8):
    pct = min(max(pct, 0), 100)
    filled = pct / 100 * width
    full = int(filled)
    frac = filled - full
    head = '█' * full
    partial = BLOCKS[round(frac * 7)]
    rest_width = width - full - (1 if partial else 0)
    rest = '─' * max(rest_width, 0)
    return (
        f'{gradient(pct)}{head}{partial}{R}'
        f'{TRACK}{rest}{R}'
    )

def fmt_bar(label, pct):
    p = round(pct)
    return f'{DIM}{label}{R} {hbar(pct)} {gradient(pct)}{p:>3}%{R}'

def short_dir(cwd):
    home = os.path.expanduser('~')
    path = cwd.replace(home, '~', 1) if cwd.startswith(home) else cwd
    segs = path.split('/')
    if len(segs) > 3:
        return '.../' + '/'.join(segs[-3:])
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
        dirty = status.stdout.strip() != ''
        return (name, dirty)
    except Exception:
        return None

cwd = data.get('workspace', {}).get('current_dir') or data.get('cwd', '')
git = git_info(cwd) if cwd else None

parts = []

# 1. Model
model = data.get('model', {}).get('display_name') or data.get('model', {}).get('id') or 'Claude'
parts.append(f'{MODEL_COLOR}{model}{R}')

# 2. Branch name (with dirty marker)
if git:
    name, dirty = git
    marker = f'{DIRTY_COLOR}*{R}' if dirty else ''
    parts.append(f'{BRANCH_COLOR}{name}{R}{marker}')

# 3. Context window usage
ctx = data.get('context_window', {}).get('used_percentage')
if ctx is not None:
    parts.append(fmt_bar('ctx', ctx))

# 4. Hourly (5h) limit
five = data.get('rate_limits', {}).get('five_hour', {}).get('used_percentage')
if five is not None:
    parts.append(fmt_bar('5h ', five))

# 5. Weekly (7d) limit
week = data.get('rate_limits', {}).get('seven_day', {}).get('used_percentage')
if week is not None:
    parts.append(fmt_bar('7d ', week))

# 6. Directory (shortened)
if cwd:
    parts.append(f'{DIM}{short_dir(cwd)}{R}')

SEP_STR = f' {SEP}│{R} '
SEP_LEN = 3  # visible width of " │ "

def detect_width():
    # Claude Code captures stdio, so fd-based detection fails.
    # Open /dev/tty to access the controlling terminal directly.
    try:
        with open('/dev/tty') as tty:
            return os.get_terminal_size(tty.fileno()).columns
    except OSError:
        pass
    for fd in (2, 1, 0):
        try:
            return os.get_terminal_size(fd).columns
        except OSError:
            continue
    try:
        cols = int(os.environ.get('COLUMNS', '0'))
        if cols:
            return cols
    except ValueError:
        pass
    try:
        out = subprocess.run(['stty', 'size'], stdin=open('/dev/tty'),
                             capture_output=True, text=True, timeout=1)
        if out.returncode == 0:
            return int(out.stdout.split()[1])
    except Exception:
        pass
    return 120

term_width = detect_width()
budget = max(term_width - 2, 20)

lines = []
current = []
current_len = 0
for p in parts:
    pl = visible_len(p)
    extra = pl + (SEP_LEN if current else 0)
    if current and current_len + extra > budget:
        lines.append(SEP_STR.join(current))
        current = [p]
        current_len = pl
    else:
        current.append(p)
        current_len += extra
if current:
    lines.append(SEP_STR.join(current))

print('\n'.join(lines), end='')

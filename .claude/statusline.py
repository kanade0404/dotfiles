#!/usr/bin/env python3
"""Status line: model | branch | ctx bar | 5h bar | 7d bar | dir"""
import json, sys, os, re, shutil, subprocess, time

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

def fmt_bar(label, pct, suffix=''):
    p = round(pct)
    tail = f' {DIM}{suffix}{R}' if suffix else ''
    return f'{DIM}{label}{R} {hbar(pct)} {gradient(pct)}{p:>3}%{R}{tail}'

def fmt_reset(ts):
    if not ts:
        return ''
    delta = int(ts) - int(time.time())
    if delta <= 0:
        return 'now'
    if delta < 60:
        return '1m'
    d, rem = divmod(delta, 86400)
    h, rem = divmod(rem, 3600)
    m, _ = divmod(rem, 60)
    if d:
        return f'{d}d{h}h'
    if h:
        return f'{h}h{m:02d}m'
    return f'{m}m'

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

# compact-prep 連携: session_id ポインタ + context 閾値警告 marker
# (get-session-id.sh / userpromptsubmit-compact-prep-reminder.sh が読む)
# fail-safe: どの書き込みが失敗しても statusline 本体は止めない
_session_id = data.get('session_id') or ''
_tmpdir = os.environ.get('TMPDIR') or '/tmp'
if _session_id:
    # session_id -> cwd ポインタ (get-session-id.sh 用)。毎ターン更新して mtime を新しく保つ
    try:
        _ptr_dir = os.path.join(_tmpdir, 'claude-session-id')
        os.makedirs(_ptr_dir, exist_ok=True)
        with open(os.path.join(_ptr_dir, _session_id), 'w') as _fh:
            _fh.write((cwd or '') + '\n')
    except OSError:
        pass

    # 閾値超で compact-prep 警告 marker を書く（cooldown 中でなければ）
    COMPACT_WARN_THRESHOLD = 60
    try:
        _int_pct = int(ctx) if ctx is not None else -1
    except (TypeError, ValueError):
        _int_pct = -1
    if _int_pct >= COMPACT_WARN_THRESHOLD:
        try:
            _warned = os.path.join(_tmpdir, 'claude-compact-warned', _session_id)
            if not os.path.exists(_warned):
                _ctx_warn_dir = os.path.join(_tmpdir, 'claude-compact-warn')
                os.makedirs(_ctx_warn_dir, exist_ok=True)
                with open(os.path.join(_ctx_warn_dir, _session_id), 'w') as _fh:
                    _fh.write(f'{_int_pct}\n')
        except OSError:
            pass

# 4. Hourly (5h) limit
five_obj = data.get('rate_limits', {}).get('five_hour', {})
five = five_obj.get('used_percentage')
if five is not None:
    reset = fmt_reset(five_obj.get('resets_at'))
    suffix = f'↻{reset}' if reset else ''
    parts.append(fmt_bar('5h ', five, suffix))

# 5. Weekly (7d) limit
week_obj = data.get('rate_limits', {}).get('seven_day', {})
week = week_obj.get('used_percentage')
if week is not None:
    reset = fmt_reset(week_obj.get('resets_at'))
    suffix = f'↻{reset}' if reset else ''
    parts.append(fmt_bar('7d ', week, suffix))

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
        with open('/dev/tty') as tty:
            out = subprocess.run(['stty', 'size'], stdin=tty,
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

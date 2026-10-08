#!/usr/bin/env python3
"""Shared handoff tool for Claude Code and Codex (deckhand mod).

Handoff files live in ~/.agent-handoff/<project>/ (AGENT_HANDOFF_DIR overrides
the root). <project> is the basename of the main working tree, so every
worktree of a repo shares one folder. The git facts at the top of each file
come from real git and gh commands, never from an agent's memory.

  handoff-state.py state [--cwd DIR] [--from NAME] [--format front-matter|json] [--no-pr]
      Print the git facts of the working tree.

  handoff-state.py write --from claude|codex --to claude|codex [--cwd DIR] [--thread ID] [--no-pr]
      Read the narrative (Markdown) from stdin, mask secrets, and write
      <stamp>-<from>-to-<to>.md plus latest-<from>-to-<to>.md. Prints JSON.

  handoff-state.py check --from claude|codex --to claude|codex [--cwd DIR] [--file PATH] [--no-pr] [--format text|json]
      Compare the latest handoff file with the repo as it is now.
      Exit 0: same. Exit 1: differences. Exit 2: no file, or unreadable.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime

VERSION = 1
PEOPLE = ('claude', 'codex')
NAMES = {'claude': 'Claude Code', 'codex': 'Codex'}
TOOL = '~/.agent-handoff/bin/handoff-state.py'
FRONT_KEYS = (
    'handoff_version', 'from', 'to', 'created_at', 'thread', 'project', 'repo_root', 'worktree',
    'git', 'branch', 'head', 'head_subject', 'upstream', 'ahead', 'behind', 'dirty_files',
    'untracked_files', 'remote_origin', 'pr_number', 'pr_url', 'pr_state',
)
EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', os.path.expanduser('~/.local/bin')]
GIT_TIMEOUT = 20
GH_TIMEOUT = 12
SYMBOL = {'ok': '✓', 'warn': '⚠', 'error': '✗', 'info': 'ℹ'}


# ── process helpers ─────────────────────────────────────────────────────────

def search_path():
    return os.pathsep.join([os.environ.get('PATH', '')] + EXTRA_PATH)


def run(argv, cwd, timeout=GIT_TIMEOUT):
    env = dict(os.environ)
    env['PATH'] = search_path()
    env['GIT_TERMINAL_PROMPT'] = '0'
    try:
        return subprocess.run(
            argv, cwd=cwd, env=env, capture_output=True,
            encoding='utf-8', errors='replace', timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def git(cwd, *args, **options):
    """Output of a git command; '' for no output, None when git fails."""
    p = run(['git', '--no-optional-locks'] + list(args), cwd, options.get('timeout', GIT_TIMEOUT))
    if p is None or p.returncode != 0:
        return None
    return p.stdout if options.get('raw') else p.stdout.strip()


def is_ancestor(cwd, older, newer):
    p = run(['git', 'merge-base', '--is-ancestor', older, newer], cwd)
    return p is not None and p.returncode == 0


# ── git facts ───────────────────────────────────────────────────────────────

def strip_credentials(url):
    return re.sub(r'^(https?://)[^/@\s]+@', r'\1', url)


def main_tree(common_dir):
    d = (common_dir or '').rstrip('/')
    return d[:-len('/.git')] if d.endswith('/.git') else None


def lookup_pr(cwd, branch):
    gh = shutil.which('gh', path=search_path())
    if not gh:
        return {}
    p = run([gh, 'pr', 'view', '--json', 'number,url,state,headRefName'], cwd, GH_TIMEOUT)
    if p is None or p.returncode != 0:
        return {}
    try:
        data = json.loads(p.stdout)
    except ValueError:
        return {}
    if data.get('headRefName') not in (None, branch):
        return {}
    return {'pr_number': data.get('number'), 'pr_url': data.get('url'), 'pr_state': data.get('state')}


def collect_state(cwd, source='', thread=None, want_pr=True, target=None):
    cwd = os.path.realpath(cwd)
    state = {
        'handoff_version': VERSION,
        'created_at': datetime.now().astimezone().isoformat(timespec='seconds'),
    }
    if source:
        state['from'] = source
    if target:
        state['to'] = target
    if thread:
        state['thread'] = thread

    top = git(cwd, 'rev-parse', '--show-toplevel')
    if top is None:
        state.update({'project': os.path.basename(cwd) or 'project', 'repo_root': cwd, 'worktree': cwd, 'git': 'false'})
        return state

    top = os.path.realpath(top)
    common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    repo_root = os.path.realpath(main_tree(common) or top)
    state.update({'project': os.path.basename(repo_root) or 'project', 'repo_root': repo_root, 'worktree': top, 'git': 'true'})

    branch = git(cwd, 'symbolic-ref', '--short', '-q', 'HEAD')
    state['branch'] = branch or '(detached)'
    head = git(cwd, 'rev-parse', 'HEAD')
    if head:
        state['head'] = head
        subject = git(cwd, 'log', '-1', '--format=%s')
        if subject:
            state['head_subject'] = subject

    upstream = git(cwd, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
    if upstream:
        state['upstream'] = upstream
        counts = git(cwd, 'rev-list', '--left-right', '--count', '@{u}...HEAD')
        if counts and len(counts.split()) == 2:
            behind, ahead = counts.split()
            state['behind'], state['ahead'] = int(behind), int(ahead)

    status = git(cwd, 'status', '--porcelain=v1', raw=True)
    if status is not None:
        lines = [line for line in status.splitlines() if line.strip()]
        state['untracked_files'] = sum(1 for line in lines if line.startswith('??'))
        state['dirty_files'] = len(lines) - state['untracked_files']
        state['_changed'] = [line[3:] for line in lines[:5]]

    remote = git(cwd, 'remote', 'get-url', 'origin')
    if remote:
        state['remote_origin'] = strip_credentials(remote)

    if want_pr and branch:
        state.update({k: v for k, v in lookup_pr(cwd, branch).items() if v not in (None, '')})
    return state


# ── front matter ────────────────────────────────────────────────────────────

def clean(value):
    return re.sub(r'[\x00-\x1f\x7f]+', ' ', str(value)).strip()


def front_matter(state):
    lines = ['---']
    for key in FRONT_KEYS:
        if state.get(key) not in (None, ''):
            lines.append('%s: %s' % (key, clean(state[key])))
    lines.append('---')
    return '\n'.join(lines)


def parse_front_matter(text):
    """(fields, body). Fields are empty when the text has no front matter."""
    lines = text.replace('\r\n', '\n').split('\n')
    if not lines or lines[0].strip() != '---':
        return {}, text
    data = {}
    for i in range(1, len(lines)):
        if lines[i].strip() == '---':
            return data, '\n'.join(lines[i + 1:])
        key, sep, value = lines[i].partition(': ')
        if sep:
            data[key.strip()] = value.strip()
    return {}, text


def public(state):
    return {k: v for k, v in state.items() if not k.startswith('_')}


def as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# ── secrets ─────────────────────────────────────────────────────────────────

SECRET_PATTERNS = [
    re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----'),
    re.compile(r'\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}'),
    re.compile(r'\bgh[pousr]_[A-Za-z0-9]{20,}'),
    re.compile(r'\bgithub_pat_[A-Za-z0-9_]{20,}'),
    re.compile(r'\bAKIA[0-9A-Z]{16}\b'),
    re.compile(r'\bxox[abprs]-[A-Za-z0-9-]{10,}'),
    re.compile(r'\bAIza[0-9A-Za-z_-]{30,}'),
    re.compile(r'\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'),
    re.compile(r'\bBearer\s+[A-Za-z0-9._~+/=-]{20,}'),
]
# user:password@ in a URL of any scheme (https, postgres, redis://:password@, mongodb+srv, ...). The scheme
# is bounded and starts at a word boundary: without that, a long run of letters (base64, minified code)
# is retried from every position and the match takes quadratic time.
URL_CREDENTIALS = re.compile(r'\b([A-Za-z][A-Za-z0-9+.-]{1,30}://)[^/\s:@]*:[^/\s@]+@')
ASSIGNMENT = re.compile(
    r'(?i)\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?))(\s*[=:]\s*)'
    r'([\'"]?)([A-Za-z0-9_\-./+=~:@%^!$*<>{}]{8,})\3'
)


def redact(text):
    """(text with secrets replaced by <REDACTED>, number of replacements)."""
    count = 0

    def assignment(m):
        nonlocal count
        value = m.group(4)
        is_placeholder = value.startswith(('<', '$', '{', '%', '/', '~', '.')) or set(value) <= set('x*.-_')
        if is_placeholder:
            return m.group(0)
        count += 1
        return '%s%s%s<REDACTED>%s' % (m.group(1), m.group(2), m.group(3), m.group(3))

    text = ASSIGNMENT.sub(assignment, text)
    for pattern in SECRET_PATTERNS:
        text, n = pattern.subn('<REDACTED>', text)
        count += n
    text, n = URL_CREDENTIALS.subn(r'\1<REDACTED>@', text)
    return text, count + n


# ── files ───────────────────────────────────────────────────────────────────

def root_dir():
    return os.environ.get('AGENT_HANDOFF_DIR') or os.path.join(os.path.expanduser('~'), '.agent-handoff')


def latest_name(source, target):
    return 'latest-%s-to-%s.md' % (source, target)


def create_exclusive(folder, base, content):
    """Write <base>.md, or <base>-2.md, ... without ever overwriting a file."""
    n = 1
    while True:
        path = os.path.join(folder, base + ('' if n == 1 else '-%d' % n) + '.md')
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            n += 1
            continue
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(content)
        return path


def write_atomic(path, content):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.tmp-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(content)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ── prompts ─────────────────────────────────────────────────────────────────

def next_prompt(source, target, path, items=None):
    head = '請讀取 %s，這是 %s 交給你的交接文件。' % (path, NAMES[source])
    if items is None:
        return head + (
            '先執行 python3 %s check --from %s --to %s，取得它與 repo 現況的差異報告；'
            '先向使用者回報差異，再依「未完成與下一步」接手；有衝突時不要自行假設。' % (TOOL, source, target)
        )
    notes = ['- %s %s' % (SYMBOL[level], text) for level, text in items if level != 'ok']
    return '\n'.join(
        [head, '以下是程式比對交接文件與目前 repo 的結果：'] + (notes or ['- 與交接文件一致'])
        + ['先向使用者回報這些差異，再依「未完成與下一步」接手；有衝突時不要自行假設。']
    )


# ── compare ─────────────────────────────────────────────────────────────────

def short(sha):
    return (sha or '')[:7]


def head_relation(cwd, old, new):
    """How the recorded HEAD relates to the current one: ahead, behind, diverged or missing."""
    if not re.fullmatch(r'[0-9a-f]{7,64}', old or '') or git(cwd, 'cat-file', '-e', old + '^{commit}') is None:
        return 'missing', 0, ''
    if is_ancestor(cwd, old, new):
        n = as_int(git(cwd, 'rev-list', '--count', '%s..%s' % (old, new))) or 0
        subjects = git(cwd, 'log', '--format=%s', '-n', '3', '%s..%s' % (old, new)) or ''
        return 'ahead', n, '；'.join(subjects.splitlines())
    if is_ancestor(cwd, new, old):
        return 'behind', as_int(git(cwd, 'rev-list', '--count', '%s..%s' % (new, old))) or 0, ''
    return 'diverged', 0, ''


def compare(recorded, current, cwd, want_pr):
    items = []

    def add(level, text):
        items.append((level, text))

    rec_root, cur_root = recorded.get('repo_root'), current.get('repo_root')
    if rec_root and rec_root != cur_root:
        add('error', '專案不同：交接文件記錄 %s，現在是 %s（可能是同名資料夾，或找錯了檔案）' % (rec_root, cur_root))
        return items
    add('ok', '專案相同：%s' % current.get('project'))
    if recorded.get('worktree') and recorded['worktree'] != current.get('worktree'):
        add('info', 'worktree 不同：交接時 %s，現在 %s（同一個 repo 的不同工作樹）' % (recorded['worktree'], current.get('worktree')))

    if recorded.get('git') == 'false' or current.get('git') == 'false':
        if recorded.get('git') != current.get('git'):
            add('warn', 'git 狀態不一致：交接時%s git，現在%s git' % (
                '不是' if recorded.get('git') == 'false' else '是', '不是' if current.get('git') == 'false' else '是'))
        return items

    if recorded.get('branch') != current.get('branch'):
        add('warn', '分支不同：交接時 %s，現在 %s' % (recorded.get('branch'), current.get('branch')))
    else:
        add('ok', '分支相同：%s' % current.get('branch'))

    old, new = recorded.get('head'), current.get('head')
    if old and new:
        if old == new:
            add('ok', 'HEAD 相同：%s %s' % (short(new), current.get('head_subject', '')))
        else:
            relation, n, subjects = head_relation(cwd, old, new)
            if relation == 'ahead':
                tail = '：' + subjects + ('…' if n > 3 else '') if subjects else ''
                add('warn', 'HEAD 已前進：交接時 %s，現在 %s（多了 %d 個 commit%s）' % (short(old), short(new), n, tail))
            elif relation == 'behind':
                add('warn', 'HEAD 落後交接點：交接時 %s，現在 %s（少了 %d 個 commit，可能尚未 pull 或 fetch）' % (short(old), short(new), n))
            elif relation == 'diverged':
                add('warn', 'HEAD 歷史已分岔：交接時 %s，現在 %s（可能被 rebase、amend，或在不同分支）' % (short(old), short(new)))
            else:
                add('warn', '交接時的 commit %s 在這個 repo 找不到（尚未 fetch，或這是不同的 repo）' % short(old))

    behind, ahead = as_int(current.get('behind')), as_int(current.get('ahead'))
    if behind:
        add('warn', '本機落後 upstream %d 個 commit（%s），尚未 pull' % (behind, current.get('upstream')))
    if ahead:
        add('info', '有 %d 個 commit 尚未 push（%s）' % (ahead, current.get('upstream')))

    rec_d, cur_d = as_int(recorded.get('dirty_files')), as_int(current.get('dirty_files'))
    rec_u, cur_u = as_int(recorded.get('untracked_files')), as_int(current.get('untracked_files'))
    if rec_d is not None and cur_d is not None:
        if (rec_d, rec_u) == (cur_d, cur_u):
            add('ok', '未提交變更數相同：tracked %d、untracked %s' % (cur_d, cur_u))
        else:
            sample = current.get('_changed') or []
            tail = '（目前：%s）' % '、'.join(sample) if sample else ''
            add('warn', '未提交變更不同：tracked %s→%s、untracked %s→%s%s' % (rec_d, cur_d, rec_u, cur_u, tail))

    if want_pr:
        rec_pr, cur_pr = recorded.get('pr_number'), current.get('pr_number')
        if rec_pr and cur_pr and str(rec_pr) == str(cur_pr):
            if recorded.get('pr_state') != current.get('pr_state'):
                add('warn', 'PR #%s 狀態改變：%s → %s' % (cur_pr, recorded.get('pr_state'), current.get('pr_state')))
            else:
                add('ok', 'PR #%s 狀態相同：%s' % (cur_pr, current.get('pr_state')))
        elif rec_pr and cur_pr:
            add('warn', '目前分支對應 PR #%s，交接文件記錄的是 PR #%s' % (cur_pr, rec_pr))
        elif rec_pr:
            add('info', '查不到 PR #%s 的現況（沒有 gh、離線，或目前分支沒有 PR）' % rec_pr)
        elif cur_pr:
            add('info', '交接後多了 PR #%s（%s）' % (cur_pr, current.get('pr_state')))
    return items


def age_text(created_at):
    try:
        then = datetime.fromisoformat(created_at)
    except (TypeError, ValueError):
        return ''
    if then.tzinfo is None:
        then = then.astimezone()
    minutes = max(0, int((datetime.now().astimezone() - then).total_seconds() // 60))
    if minutes < 60:
        return '%d 分鐘前' % minutes
    hours = minutes // 60
    return '%d 小時前' % hours if hours < 48 else '%d 天前' % (hours // 24)


def difference_count(items):
    return sum(1 for level, _ in items if level in ('warn', 'error'))


def render_report(path, recorded, items):
    n = difference_count(items)
    lines = [
        '交接檢查：%s' % path,
        '建立於 %s（%s）· 來自 %s' % (recorded.get('created_at', '?'), age_text(recorded.get('created_at')) or '?', recorded.get('from', '?')),
    ] + ['%s %s' % (SYMBOL[level], text) for level, text in items]
    lines.append('結論：與交接文件一致' if n == 0 else '結論：%d 項差異，先向使用者回報差異，再接手' % n)
    return '\n'.join(lines)


# ── commands ────────────────────────────────────────────────────────────────

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + '\n')


def fail(message, code=2):
    sys.stderr.write('handoff-state: %s\n' % message)
    sys.exit(code)


def cmd_state(args):
    state = collect_state(args.cwd, args.source, args.thread, not args.no_pr)
    if args.format == 'json':
        emit(public(state))
    else:
        sys.stdout.write(front_matter(state) + '\n')
    return 0


def cmd_write(args):
    if sys.stdin.isatty():
        fail('pipe the narrative (Markdown) on stdin, for example with a heredoc')
    narrative = sys.stdin.read()
    fields, body = parse_front_matter(narrative)
    narrative, redacted = redact(body if fields else narrative)
    narrative = narrative.strip()
    if not narrative:
        fail('the narrative on stdin is empty')

    state = collect_state(args.cwd, args.source, args.thread, not args.no_pr, args.dst)
    root = root_dir()
    folder = os.path.join(root, state['project'])
    os.makedirs(root, mode=0o700, exist_ok=True)
    os.makedirs(folder, mode=0o700, exist_ok=True)

    content = front_matter(state) + '\n\n' + narrative + '\n'
    base = '%s-%s-to-%s' % (datetime.now().strftime('%Y%m%d-%H%M'), args.source, args.dst)
    path = create_exclusive(folder, base, content)
    latest = os.path.join(folder, latest_name(args.source, args.dst))
    write_atomic(latest, content)

    emit({
        'path': path,
        'latest': latest,
        'project': state['project'],
        'redacted': redacted,
        'state': public(state),
        'next_prompt': next_prompt(args.source, args.dst, path),
    })
    return 0


def cmd_check(args):
    cwd = os.path.realpath(args.cwd)
    current = collect_state(cwd, want_pr=not args.no_pr)
    path = args.file or os.path.join(root_dir(), current['project'], latest_name(args.source, args.dst))
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read()
    except OSError:
        if args.format == 'json':
            emit({'error': 'missing', 'path': path})
        else:
            sys.stdout.write('找不到交接文件：%s\n' % path)
        return 2
    recorded, _ = parse_front_matter(text)
    if not recorded:
        if args.format == 'json':
            emit({'error': 'no-front-matter', 'path': path})
        else:
            sys.stdout.write('這個檔案沒有 front matter（不是這個工具寫的），請直接閱讀內容：%s\n' % path)
        return 2

    items = compare(recorded, current, cwd, not args.no_pr)
    n = difference_count(items)
    report = render_report(path, recorded, items)
    if args.format == 'json':
        emit({
            'path': path,
            'created_at': recorded.get('created_at', ''),
            'age': age_text(recorded.get('created_at')),
            'differences': n,
            'items': [{'level': level, 'text': text} for level, text in items],
            'report': report,
            'next_prompt': next_prompt(args.source, args.dst, path, items),
        })
    else:
        sys.stdout.write(report + '\n')
    return 0 if n == 0 else 1


def build_parser():
    parser = argparse.ArgumentParser(prog='handoff-state.py', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)

    def common(p, direction, fmt):
        p.add_argument('--cwd', default=os.getcwd())
        p.add_argument('--no-pr', action='store_true', help='skip the gh pr lookup')
        if direction:
            p.add_argument('--from', dest='source', choices=PEOPLE, required=True)
            p.add_argument('--to', dest='dst', choices=PEOPLE, required=True)
        if fmt:
            p.add_argument('--format', choices=fmt, default=fmt[0])

    state = sub.add_parser('state', help='print the git facts of the working tree')
    common(state, False, ('front-matter', 'json'))
    state.add_argument('--from', dest='source', choices=PEOPLE, default='')
    state.add_argument('--thread')
    state.set_defaults(run=cmd_state)

    write = sub.add_parser('write', help='write a handoff file (narrative on stdin)')
    common(write, True, None)
    write.add_argument('--thread')
    write.set_defaults(run=cmd_write)

    check = sub.add_parser('check', help='compare the latest handoff file with the repo now')
    common(check, True, ('text', 'json'))
    check.add_argument('--file')
    check.set_defaults(run=cmd_check)
    return parser


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    args = build_parser().parse_args()
    if getattr(args, 'dst', None) and args.source == args.dst:
        fail('--from and --to must differ')
    sys.exit(args.run(args))


if __name__ == '__main__':
    main()

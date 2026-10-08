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

Every command takes --lang (else env DECKHAND_LANG, else English) for its human-readable text: the
report, the prompt for the agent taking over, the messages. File names, front matter and JSON
field names never change with the language. A copy of this file that runs without i18n.py next to
it (the shared one in ~/.agent-handoff/bin) speaks English.
"""
import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # loading i18n.py must not leave a __pycache__ next to this file


def _load_i18n():
    try:
        spec = importlib.util.spec_from_file_location('deckhand_i18n', os.path.join(HERE, 'i18n.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:  # noqa: BLE001 - a copy without i18n.py next to it speaks English
        return None


i18n = _load_i18n()
LOCALE = 'en'

# The English messages of this file, for a copy without i18n.py next to it. tests/test_handoff_state.py
# holds them equal to i18n.py's.
FALLBACK_EN = {
    'common.list_sep': ', ',
    'common.clause_sep': '; ',
    'handoff.prompt.read': 'Read {path}: it is the handoff document {source} left for you.',
    'handoff.prompt.check_first': 'First run python3 {tool} check --from {source} --to {target} --lang {lang} to get a report of how it differs from the repo now. Report the differences to the user first, then take over from the section on unfinished work and next steps. Where something conflicts, do not assume.',
    'handoff.prompt.compared': 'The tool compared the handoff document with the repo as it is now:',
    'handoff.prompt.consistent': 'consistent with the handoff document',
    'handoff.prompt.report_first': 'Report these differences to the user first, then take over from the section on unfinished work and next steps. Where something conflicts, do not assume.',
    'handoff.item.project_differs': 'Different project: the handoff document records {recorded}, this is {current} (perhaps a folder of the same name, or the wrong file)',
    'handoff.item.project_same': 'Same project: {project}',
    'handoff.item.worktree_differs': 'Different worktree: {recorded} at handoff, {current} now (another working tree of the same repo)',
    'handoff.item.git_gone': 'Git status differs: a git repo at handoff, not a git repo now',
    'handoff.item.git_new': 'Git status differs: not a git repo at handoff, a git repo now',
    'handoff.item.branch_differs': 'Different branch: {recorded} at handoff, {current} now',
    'handoff.item.branch_same': 'Same branch: {branch}',
    'handoff.item.head_same': 'Same HEAD: {head} {subject}',
    'handoff.item.head_ahead': 'HEAD moved ahead: {old} at handoff, {new} now ({count} new commit(s){subjects})',
    'handoff.item.head_subjects': ': {subjects}',
    'handoff.item.head_behind': 'HEAD is behind the handoff point: {old} at handoff, {new} now ({count} commit(s) fewer; perhaps not pulled or fetched yet)',
    'handoff.item.head_diverged': 'HEAD history has diverged: {old} at handoff, {new} now (perhaps rebased, amended, or on another branch)',
    'handoff.item.head_missing': 'The handoff commit {old} was not found in this repo (not fetched yet, or a different repo)',
    'handoff.item.upstream_behind': 'The local branch is {count} commit(s) behind upstream ({upstream}); not pulled yet',
    'handoff.item.unpushed': '{count} commit(s) not pushed yet ({upstream})',
    'handoff.item.changes_same': 'Same number of uncommitted changes: tracked {tracked}, untracked {untracked}',
    'handoff.item.changes_differ': 'Uncommitted changes differ: tracked {tracked_before}→{tracked_now}, untracked {untracked_before}→{untracked_now}{files}',
    'handoff.item.changes_files': ' (now: {files})',
    'handoff.item.pr_changed': 'PR #{pr} state changed: {before} → {now}',
    'handoff.item.pr_same': 'PR #{pr} state unchanged: {state}',
    'handoff.item.pr_other': 'The current branch has PR #{current}; the handoff document records PR #{recorded}',
    'handoff.item.pr_unknown': 'Could not look up PR #{pr} (no gh, offline, or the current branch has no PR)',
    'handoff.item.pr_new': 'PR #{pr} was opened after the handoff ({state})',
    'handoff.age.minutes': '{count} min ago',
    'handoff.age.hours': '{count} h ago',
    'handoff.age.days': '{count} d ago',
    'handoff.report.title': 'Handoff check: {path}',
    'handoff.report.created': 'Created {created} ({age}) · from {source}',
    'handoff.report.consistent': 'Conclusion: consistent with the handoff document',
    'handoff.report.differences': 'Conclusion: {count} difference(s); report them to the user before taking over',
    'handoff.check.missing': 'No handoff document found: {path}',
    'handoff.check.no_front_matter': 'This file has no front matter (this tool did not write it); read its content directly: {path}',
    'handoff.err.no_stdin': 'pipe the narrative (Markdown) on stdin, for example with a heredoc',
    'handoff.err.empty': 'the narrative on stdin is empty',
    'handoff.err.same_direction': '--from and --to must differ',
}


def _(key, **values):
    if i18n is not None:
        return i18n.t(LOCALE, key, **values)
    return FALLBACK_EN[key].format(**values)


def _join(items, sep='common.list_sep'):
    return _(sep).join(str(item) for item in items)


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
    head = _('handoff.prompt.read', path=path, source=NAMES[source])
    if items is None:
        return head + '\n' + _('handoff.prompt.check_first', tool=TOOL, source=source, target=target, lang=LOCALE)
    notes = ['- %s %s' % (SYMBOL[level], text) for level, text in items if level != 'ok']
    return '\n'.join(
        [head, _('handoff.prompt.compared')] + (notes or ['- ' + _('handoff.prompt.consistent')])
        + [_('handoff.prompt.report_first')]
    )


# ── compare ─────────────────────────────────────────────────────────────────

def short(sha):
    return (sha or '')[:7]


def head_relation(cwd, old, new):
    """How the recorded HEAD relates to the current one: ahead, behind, diverged or missing."""
    if not re.fullmatch(r'[0-9a-f]{7,64}', old or '') or git(cwd, 'cat-file', '-e', old + '^{commit}') is None:
        return 'missing', 0, []
    if is_ancestor(cwd, old, new):
        n = as_int(git(cwd, 'rev-list', '--count', '%s..%s' % (old, new))) or 0
        subjects = git(cwd, 'log', '--format=%s', '-n', '3', '%s..%s' % (old, new)) or ''
        return 'ahead', n, subjects.splitlines()
    if is_ancestor(cwd, new, old):
        return 'behind', as_int(git(cwd, 'rev-list', '--count', '%s..%s' % (new, old))) or 0, []
    return 'diverged', 0, []


def compare(recorded, current, cwd, want_pr):
    items = []

    def add(level, key, **values):
        items.append((level, _(key, **values)))

    rec_root, cur_root = recorded.get('repo_root'), current.get('repo_root')
    if rec_root and rec_root != cur_root:
        add('error', 'handoff.item.project_differs', recorded=rec_root, current=cur_root)
        return items
    add('ok', 'handoff.item.project_same', project=current.get('project'))
    if recorded.get('worktree') and recorded['worktree'] != current.get('worktree'):
        add('info', 'handoff.item.worktree_differs', recorded=recorded['worktree'], current=current.get('worktree'))

    if recorded.get('git') == 'false' or current.get('git') == 'false':
        if recorded.get('git') != current.get('git'):
            add('warn', 'handoff.item.git_gone' if current.get('git') == 'false' else 'handoff.item.git_new')
        return items

    if recorded.get('branch') != current.get('branch'):
        add('warn', 'handoff.item.branch_differs', recorded=recorded.get('branch'), current=current.get('branch'))
    else:
        add('ok', 'handoff.item.branch_same', branch=current.get('branch'))

    old, new = recorded.get('head'), current.get('head')
    if old and new:
        if old == new:
            add('ok', 'handoff.item.head_same', head=short(new), subject=current.get('head_subject', ''))
        else:
            relation, n, subjects = head_relation(cwd, old, new)
            if relation == 'ahead':
                tail = _('handoff.item.head_subjects', subjects=_join(subjects, 'common.clause_sep') + ('…' if n > 3 else '')) if subjects else ''
                add('warn', 'handoff.item.head_ahead', old=short(old), new=short(new), count=n, subjects=tail)
            elif relation == 'behind':
                add('warn', 'handoff.item.head_behind', old=short(old), new=short(new), count=n)
            elif relation == 'diverged':
                add('warn', 'handoff.item.head_diverged', old=short(old), new=short(new))
            else:
                add('warn', 'handoff.item.head_missing', old=short(old))

    behind, ahead = as_int(current.get('behind')), as_int(current.get('ahead'))
    if behind:
        add('warn', 'handoff.item.upstream_behind', count=behind, upstream=current.get('upstream'))
    if ahead:
        add('info', 'handoff.item.unpushed', count=ahead, upstream=current.get('upstream'))

    rec_d, cur_d = as_int(recorded.get('dirty_files')), as_int(current.get('dirty_files'))
    rec_u, cur_u = as_int(recorded.get('untracked_files')), as_int(current.get('untracked_files'))
    if rec_d is not None and cur_d is not None:
        if (rec_d, rec_u) == (cur_d, cur_u):
            add('ok', 'handoff.item.changes_same', tracked=cur_d, untracked=cur_u)
        else:
            sample = current.get('_changed') or []
            tail = _('handoff.item.changes_files', files=_join(sample)) if sample else ''
            add('warn', 'handoff.item.changes_differ', tracked_before=rec_d, tracked_now=cur_d,
                untracked_before=rec_u, untracked_now=cur_u, files=tail)

    if want_pr:
        rec_pr, cur_pr = recorded.get('pr_number'), current.get('pr_number')
        if rec_pr and cur_pr and str(rec_pr) == str(cur_pr):
            if recorded.get('pr_state') != current.get('pr_state'):
                add('warn', 'handoff.item.pr_changed', pr=cur_pr, before=recorded.get('pr_state'), now=current.get('pr_state'))
            else:
                add('ok', 'handoff.item.pr_same', pr=cur_pr, state=current.get('pr_state'))
        elif rec_pr and cur_pr:
            add('warn', 'handoff.item.pr_other', current=cur_pr, recorded=rec_pr)
        elif rec_pr:
            add('info', 'handoff.item.pr_unknown', pr=rec_pr)
        elif cur_pr:
            add('info', 'handoff.item.pr_new', pr=cur_pr, state=current.get('pr_state'))
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
        return _('handoff.age.minutes', count=minutes)
    hours = minutes // 60
    return _('handoff.age.hours', count=hours) if hours < 48 else _('handoff.age.days', count=hours // 24)


def difference_count(items):
    return sum(1 for level, _text in items if level in ('warn', 'error'))


def render_report(path, recorded, items):
    n = difference_count(items)
    lines = [
        _('handoff.report.title', path=path),
        _('handoff.report.created', created=recorded.get('created_at', '?'),
          age=age_text(recorded.get('created_at')) or '?', source=recorded.get('from', '?')),
    ] + ['%s %s' % (SYMBOL[level], text) for level, text in items]
    lines.append(_('handoff.report.consistent') if n == 0 else _('handoff.report.differences', count=n))
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
        fail(_('handoff.err.no_stdin'))
    narrative = sys.stdin.read()
    fields, body = parse_front_matter(narrative)
    narrative, redacted = redact(body if fields else narrative)
    narrative = narrative.strip()
    if not narrative:
        fail(_('handoff.err.empty'))

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
            sys.stdout.write(_('handoff.check.missing', path=path) + '\n')
        return 2
    recorded, _body = parse_front_matter(text)
    if not recorded:
        if args.format == 'json':
            emit({'error': 'no-front-matter', 'path': path})
        else:
            sys.stdout.write(_('handoff.check.no_front_matter', path=path) + '\n')
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
    parser.add_argument('--lang', help='language of the human-readable text (default: env DECKHAND_LANG, else en)')
    sub = parser.add_subparsers(dest='command', required=True)

    def common(p, direction, fmt):
        p.add_argument('--cwd', default=os.getcwd())
        p.add_argument('--lang', default=argparse.SUPPRESS, help='language of the human-readable text')
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
    global LOCALE
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    args = build_parser().parse_args()
    LOCALE = i18n.resolve(args.lang) if i18n is not None else 'en'
    if getattr(args, 'dst', None) and args.source == args.dst:
        fail(_('handoff.err.same_direction'))
    sys.exit(args.run(args))


if __name__ == '__main__':
    main()

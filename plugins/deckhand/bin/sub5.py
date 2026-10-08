#!/usr/bin/env python3
"""Sub5 helper (deckhand mod): the exact, safe git parts of the Sub5 flow.

The model decides what to split, reviews and integrates. This tool does what
must be exact and must never touch anything it did not create:

  sub5.py base     [--cwd DIR] [--run ID]
      Snapshot the task's latest results as the base every worker starts from.
      Clean tree: the base is HEAD. Uncommitted work: the base is a snapshot
      commit built with a throwaway index; your branch, index and working tree
      are not touched. Prints JSON (run, mode, base, scratch, ...).

  sub5.py register --run ID --item N --branch B --worktree PATH [--title T]
      Record a worker's branch and worktree after it reports. Only a worktree
      of this repo, and never the main checkout, can be registered.

  sub5.py apply    --run ID --item N [--three-way]
      Apply a worker's changes (base..branch) to the main working tree without
      committing. Atomic: a patch that does not apply leaves the tree as it was.

  sub5.py check    --run ID [--format text|json]
      Is each worker's work in the working tree? merged | applied | pending | empty | missing.

  sub5.py cleanup  --run ID [--dry-run] [--assume-integrated 1,3] [--stop-processes] [--keep-base]
      Remove what the run created, for integrated items only: worktree, branch,
      the base ref, scratch and the manifest. Never forces: a dirty worktree, a
      busy one or an unintegrated item is skipped with the reason.

  sub5.py status
      List runs, and worktrees that look like worker leftovers but no run owns.

Every run is a manifest under <git-common-dir>/deckhand-sub5/<run>/ (falling
back to the temp folder when that is not writable). Only what is in a manifest
is ever deleted.

Every command takes --lang (else env DECKHAND_LANG, else English) for its
human-readable lines. JSON output, exit codes and states never change with it.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # loading i18n.py must not leave a __pycache__ in bin/


def _load_i18n():
    spec = importlib.util.spec_from_file_location('deckhand_i18n', os.path.join(HERE, 'i18n.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


i18n = _load_i18n()
LOCALE = i18n.DEFAULT


def _(key, **values):
    return i18n.t(LOCALE, key, **values)


EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/sbin', os.path.expanduser('~/.local/bin')]
RUN_RE = re.compile(r'^s5-\d{8}-\d{6}$')
ITEM_RE = re.compile(r'^[1-9]\d?$')
SYMBOL = {'ok': '✓', 'warn': '⚠', 'info': 'ℹ', 'error': '✗'}
INTEGRATED = ('merged', 'applied', 'empty', 'missing')


class ToolError(Exception):
    def __init__(self, message, code=2):
        Exception.__init__(self, message)
        self.message = message
        self.code = code


# ── process helpers ─────────────────────────────────────────────────────────

def search_path():
    return os.pathsep.join([os.environ.get('PATH', '')] + EXTRA_PATH)


def run(argv, cwd=None, env=None, data=None, timeout=120, binary=False):
    full = dict(os.environ)
    full['PATH'] = search_path()
    full['GIT_TERMINAL_PROMPT'] = '0'
    if env:
        full.update(env)
    options = {} if binary else {'encoding': 'utf-8', 'errors': 'replace'}
    try:
        return subprocess.run(argv, cwd=cwd, env=full, input=data, capture_output=True, timeout=timeout, **options)
    except (OSError, subprocess.TimeoutExpired):
        return None


def git(cwd, *args, **kw):
    return run(['git', '--no-optional-locks'] + list(args), cwd=cwd, **kw)


def gout(cwd, *args, **kw):
    """Stripped stdout of a git command; None when it fails."""
    p = git(cwd, *args, **kw)
    return None if p is None or p.returncode != 0 else p.stdout.strip()


def gok(cwd, *args):
    p = git(cwd, *args)
    return p is not None and p.returncode == 0


def first_line(text):
    lines = [line for line in (text or '').strip().splitlines() if line.strip()]
    return lines[0] if lines else ''


# ── repo ────────────────────────────────────────────────────────────────────

def main_tree(common_dir):
    d = (common_dir or '').rstrip('/')
    return d[:-len('/.git')] if d.endswith('/.git') else None


class Repo(object):
    def __init__(self, cwd):
        cwd = os.path.realpath(cwd)
        top = gout(cwd, 'rev-parse', '--show-toplevel')
        if top is None:
            raise ToolError(_('sub5.err.not_git'))
        self.top = os.path.realpath(top)
        common = gout(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
        self.common = os.path.realpath(common or os.path.join(self.top, '.git'))
        self.root = os.path.realpath(main_tree(common) or self.top)

    @property
    def head(self):
        return gout(self.top, 'rev-parse', '--verify', '-q', 'HEAD')

    @property
    def branch(self):
        return gout(self.top, 'symbolic-ref', '--short', '-q', 'HEAD') or '(detached)'

    def status_lines(self, path=None):
        p = git(path or self.top, 'status', '--porcelain=v1')
        if p is None or p.returncode != 0:
            return None
        return [line for line in p.stdout.splitlines() if line.strip()]


def in_progress(repo):
    git_dir = gout(repo.top, 'rev-parse', '--absolute-git-dir')
    if not git_dir:
        return False
    return any(os.path.exists(os.path.join(git_dir, n)) for n in ('MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'))


def worktrees(repo):
    """{realpath: {'branch': 'refs/heads/x' | None, 'head': sha, 'locked': bool}} of this repo."""
    out = gout(repo.top, 'worktree', 'list', '--porcelain') or ''
    found, current = {}, None
    for line in out.splitlines():
        if line.startswith('worktree '):
            current = {'branch': None, 'head': '', 'locked': False}
            found[os.path.realpath(line[len('worktree '):])] = current
        elif current is not None:
            if line.startswith('branch '):
                current['branch'] = line[len('branch '):]
            elif line.startswith('HEAD '):
                current['head'] = line[len('HEAD '):]
            elif line.startswith('locked'):
                current['locked'] = True
    return found


def is_ancestor(cwd, older, newer):
    p = git(cwd, 'merge-base', '--is-ancestor', older, newer)
    return p is not None and p.returncode == 0


# ── manifests ───────────────────────────────────────────────────────────────

def stores(repo):
    primary = os.path.join(repo.common, 'deckhand-sub5')
    fallback = os.path.join(tempfile.gettempdir(), 'deckhand-sub5', hashlib.sha1(repo.common.encode('utf-8')).hexdigest()[:10])
    return [primary, fallback]


def find_run_dir(repo, run_id):
    for base in stores(repo):
        d = os.path.join(base, run_id)
        if os.path.isfile(os.path.join(d, 'manifest.json')):
            return d
    return None


def new_run_dir(repo, run_id):
    for base in stores(repo):
        d = os.path.join(base, run_id)
        try:
            os.makedirs(os.path.join(d, 'scratch'))
            return d
        except OSError:
            continue
    raise ToolError(_('sub5.err.no_store', path=stores(repo)[0]))


def save(run_dir, manifest):
    path = os.path.join(run_dir, 'manifest.json')
    fd, tmp = tempfile.mkstemp(dir=run_dir, prefix='.tmp-')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def load(args):
    repo = Repo(args.cwd)
    if not RUN_RE.match(args.run or ''):
        raise ToolError(_('sub5.err.bad_run'))
    run_dir = find_run_dir(repo, args.run)
    if not run_dir:
        raise ToolError(_('sub5.err.run_not_found', run=args.run))
    with open(os.path.join(run_dir, 'manifest.json'), encoding='utf-8') as f:
        return repo, run_dir, json.load(f)


def item_number(value):
    if not ITEM_RE.match(str(value)):
        raise ToolError(_('sub5.err.bad_item'))
    return str(value)


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + '\n')


# ── base ────────────────────────────────────────────────────────────────────

IDENTITY = {
    'GIT_AUTHOR_NAME': 'sub5', 'GIT_AUTHOR_EMAIL': 'sub5@localhost',
    'GIT_COMMITTER_NAME': 'sub5', 'GIT_COMMITTER_EMAIL': 'sub5@localhost',
}


def snapshot(repo, run_id):
    """A commit of the working tree as it is now (tracked and untracked, not ignored), child of HEAD.

    Built with a throwaway index and commit-tree: the real index, the branch and the working
    tree are not touched, and nothing lands in the user's history."""
    tmp = tempfile.mkdtemp(prefix='sub5-index-')
    env = {'GIT_INDEX_FILE': os.path.join(tmp, 'index')}
    try:
        for args in (('read-tree', repo.head), ('add', '-A')):
            p = git(repo.top, *args, env=env)
            if p is None or p.returncode != 0:
                raise ToolError(_('sub5.err.snapshot', step=args[0], detail=first_line(p.stderr if p else '')))
        tree = gout(repo.top, 'write-tree', env=env)
        if not tree:
            raise ToolError(_('sub5.err.snapshot_step', step='write-tree'))
        message = 'sub5 base snapshot (%s)' % run_id
        commit = gout(repo.top, 'commit-tree', tree, '-p', repo.head, '-m', message, env=env)
        if not commit:
            commit = gout(repo.top, 'commit-tree', tree, '-p', repo.head, '-m', message, env=dict(env, **IDENTITY))
        if not commit:
            raise ToolError(_('sub5.err.snapshot_identity'))
        return commit
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def cmd_base(args):
    repo = Repo(args.cwd)
    head = repo.head
    if not head:
        raise ToolError(_('sub5.err.no_commit'))
    if in_progress(repo):
        raise ToolError(_('sub5.err.in_progress'))
    run_id = args.run or time.strftime('s5-%Y%m%d-%H%M%S')
    if not RUN_RE.match(run_id):
        raise ToolError(_('sub5.err.bad_run'))
    if find_run_dir(repo, run_id):
        raise ToolError(_('sub5.err.run_exists', run=run_id))

    lines = repo.status_lines() or []
    untracked = sum(1 for line in lines if line.startswith('??'))
    mode = 'dirty' if lines else 'clean'
    base = snapshot(repo, run_id) if mode == 'dirty' else head
    ref = 'refs/sub5/%s/base' % run_id
    if not gok(repo.top, 'update-ref', ref, base):
        raise ToolError(_('sub5.err.update_ref', ref=ref))

    run_dir = new_run_dir(repo, run_id)
    manifest = {
        'version': 1, 'run': run_id, 'created_at': datetime.now().astimezone().isoformat(timespec='seconds'),
        'repo_root': repo.root, 'main_worktree': repo.top, 'branch': repo.branch, 'head': head,
        'mode': mode, 'base': base, 'base_ref': ref, 'scratch': os.path.join(run_dir, 'scratch'), 'items': {},
    }
    save(run_dir, manifest)
    emit({
        'run': run_id, 'mode': mode, 'base': base, 'head': head, 'branch': repo.branch,
        'repo_root': repo.root, 'worktree': repo.top, 'scratch': manifest['scratch'],
        'manifest': os.path.join(run_dir, 'manifest.json'),
        'wip': {'tracked': len(lines) - untracked, 'untracked': untracked},
        'note': _('sub5.note.clean') if mode == 'clean' else _('sub5.note.dirty'),
    })
    return 0


# ── register ────────────────────────────────────────────────────────────────

def cmd_register(args):
    repo, run_dir, m = load(args)
    n = item_number(args.item)
    if not gok(repo.top, 'check-ref-format', '--branch', args.branch):
        raise ToolError(_('sub5.err.bad_branch', branch=args.branch))
    tip = gout(repo.top, 'rev-parse', '--verify', '-q', 'refs/heads/' + args.branch)
    if not tip:
        raise ToolError(_('sub5.err.no_branch', branch=args.branch))
    wt = os.path.realpath(args.worktree)
    known = worktrees(repo)
    if wt not in known:
        raise ToolError(_('sub5.err.not_worktree', path=wt))
    if wt in (repo.root, os.path.realpath(m['main_worktree']), repo.top):
        raise ToolError(_('sub5.err.main_worktree'))
    on_branch = known[wt]['branch']
    if on_branch and on_branch != 'refs/heads/' + args.branch:
        raise ToolError(_('sub5.err.worktree_branch', path=wt, current=on_branch, branch=args.branch))
    commits = int(gout(repo.top, 'rev-list', '--count', '%s..%s' % (m['base'], tip)) or 0)
    dirty = repo.status_lines(wt) or []
    m['items'][n] = {
        'title': args.title or '', 'branch': args.branch, 'worktree': wt,
        'registered_at': datetime.now().astimezone().isoformat(timespec='seconds'),
        'assumed': False,
    }
    save(run_dir, m)
    emit({'item': n, 'branch': args.branch, 'tip': tip, 'commits': commits, 'worktree': wt,
          'worktree_dirty': len(dirty), 'base_is_ancestor': is_ancestor(repo.top, m['base'], tip)})
    return 0


# ── state of an item ────────────────────────────────────────────────────────

def changed_files(repo, base, tip):
    p = git(repo.top, 'diff', '--name-status', '-z', '--no-renames', base, tip, binary=True)
    if p is None or p.returncode != 0:
        return None
    parts = p.stdout.decode('utf-8', 'replace').split('\0')
    return [(parts[i], parts[i + 1]) for i in range(0, len(parts) - 1, 2) if parts[i]]


def same_as_tip(repo, main, tip, status, path):
    full = os.path.join(main, path)
    if status.startswith('D'):
        return not os.path.lexists(full)
    mode_line = gout(repo.top, 'ls-tree', tip, '--', path) or ''
    mode = mode_line.split(' ', 1)[0]
    if mode == '160000':
        return True
    blob = git(repo.top, 'cat-file', 'blob', '%s:%s' % (tip, path), binary=True)
    if blob is None or blob.returncode != 0:
        return False
    if mode == '120000':
        return os.path.islink(full) and os.readlink(full).encode('utf-8', 'surrogateescape') == blob.stdout
    try:
        with open(full, 'rb') as f:
            return f.read() == blob.stdout
    except OSError:
        return False


def item_state(repo, m, n, item, known):
    main = m['main_worktree']
    wt = item['worktree']
    state = {'item': n, 'title': item.get('title', ''), 'branch': item['branch'], 'worktree': wt,
             'worktree_exists': os.path.realpath(wt) in known and os.path.isdir(wt), 'worktree_dirty': 0,
             'commits': 0, 'integration': 'missing', 'differing': []}
    if state['worktree_exists']:
        state['worktree_dirty'] = len(repo.status_lines(wt) or [])
    tip = gout(repo.top, 'rev-parse', '--verify', '-q', 'refs/heads/' + item['branch'])
    state['tip'] = tip
    if not tip:
        return state
    state['commits'] = int(gout(repo.top, 'rev-list', '--count', '%s..%s' % (m['base'], tip)) or 0)
    if state['commits'] == 0:
        state['integration'] = 'empty'
        return state
    head = gout(main, 'rev-parse', '--verify', '-q', 'HEAD')
    if head and is_ancestor(repo.top, tip, head):
        state['integration'] = 'merged'
        return state
    files = changed_files(repo, m['base'], tip)
    if files is None:
        state['integration'] = 'pending'
        return state
    state['differing'] = [path for status, path in files if not same_as_tip(repo, main, tip, status, path)]
    state['integration'] = 'applied' if not state['differing'] else 'pending'
    return state


def item_label(n, title=''):
    return _('sub5.item_titled', n=n, title=title) if title else _('sub5.item', n=n)


def describe(state):
    """(level, the item's label, what its state means). The line is _('sub5.item_line', ...)."""
    labels = {
        'merged': ('ok', 'sub5.state.merged'),
        'applied': ('ok', 'sub5.state.applied'),
        'empty': ('info', 'sub5.state.empty'),
        'missing': ('info', 'sub5.state.missing'),
    }
    if state['integration'] in labels:
        level, key = labels[state['integration']]
        text = _(key)
    else:
        level, files = 'warn', state['differing']
        if not files:
            text = _('sub5.state.pending')
        else:
            shown = i18n.join(LOCALE, files[:6])
            if len(files) > 6:
                shown = _('sub5.state.more_files', files=shown, count=len(files))
            text = _('sub5.state.pending_files', files=shown)
    if state['worktree_dirty']:
        text += _('common.clause_sep') + _('sub5.state.worktree_dirty', count=state['worktree_dirty'])
    return level, item_label(state['item'], state['title']), text


def describe_line(state):
    level, label, text = describe(state)
    return level, _('sub5.item_line', item=label, text=text)


# ── apply ───────────────────────────────────────────────────────────────────

def cmd_apply(args):
    repo, run_dir, m = load(args)
    n = item_number(args.item)
    label = item_label(n)
    if n not in m['items']:
        raise ToolError(_('sub5.err.not_registered', item=label))
    item = m['items'][n]
    state = item_state(repo, m, n, item, worktrees(repo))
    if state['integration'] in ('merged', 'applied', 'empty'):
        sys.stdout.write(_('sub5.apply.not_needed', item=label, state=describe(state)[2]) + '\n')
        return 0
    if not state['tip']:
        raise ToolError(_('sub5.err.branch_gone', item=label, branch=item['branch']))
    if state['worktree_dirty']:
        sys.stdout.write('%s %s\n' % (SYMBOL['warn'], _('sub5.apply.dirty_worktree', item=label, count=state['worktree_dirty'])))
    main = m['main_worktree']
    patch = git(main, 'diff', '--binary', '--full-index', m['base'], state['tip'], binary=True)
    if patch is None or patch.returncode != 0:
        raise ToolError(_('sub5.err.no_diff', item=label))
    flags = ['--whitespace=nowarn'] + (['--3way'] if args.three_way else [])
    if not args.three_way:
        check = run(['git', 'apply', '--check'] + flags + ['-'], cwd=main, data=patch.stdout, binary=True)
        if check is None or check.returncode != 0:
            detail = check.stderr.decode('utf-8', 'replace').strip() if check else _('sub5.apply.cannot_run')
            sys.stdout.write('%s %s\n%s\n' % (SYMBOL['error'], _('sub5.apply.not_clean', item=label), detail))
            sys.stdout.write(_('sub5.apply.hint') + '\n')
            return 1
    done = run(['git', 'apply'] + flags + ['-'], cwd=main, data=patch.stdout, binary=True)
    if done is None or done.returncode != 0:
        detail = done.stderr.decode('utf-8', 'replace').strip() if done else ''
        sys.stdout.write('%s %s\n%s\n' % (SYMBOL['error'], _('sub5.apply.failed', item=label), detail))
        return 1
    item['applied_at'] = datetime.now().astimezone().isoformat(timespec='seconds')
    item['applied_tip'] = state['tip']
    save(run_dir, m)
    after = item_state(repo, m, n, item, worktrees(repo))
    sys.stdout.write('%s %s\n' % (SYMBOL['ok'], _('sub5.apply.done', item=label, state=describe(after)[2])))
    return 0


# ── check ───────────────────────────────────────────────────────────────────

def cmd_check(args):
    repo, run_dir, m = load(args)
    known = worktrees(repo)
    states = [item_state(repo, m, n, m['items'][n], known) for n in sorted(m['items'], key=int)]
    pending = [s for s in states if s['integration'] not in INTEGRATED]
    if args.format == 'json':
        emit({'run': m['run'], 'mode': m['mode'], 'base': m['base'], 'items': states, 'pending': len(pending)})
    else:
        sys.stdout.write(_('sub5.check.header', run=m['run'], base=m['base'][:7], mode=m['mode']) + '\n')
        if not states:
            sys.stdout.write('%s %s\n' % (SYMBOL['info'], _('sub5.check.no_items')))
        for s in states:
            level, text = describe_line(s)
            sys.stdout.write('%s %s\n' % (SYMBOL[level], text))
        sys.stdout.write((_('sub5.check.all_done') if not pending else _('sub5.check.pending', count=len(pending))) + '\n')
    return 0 if not pending else 1


# ── processes ───────────────────────────────────────────────────────────────

def processes_in(path):
    """[(pid, command)] of processes whose working directory is inside path; None when that cannot be told."""
    p = run(['lsof', '-d', 'cwd', '-Fpcn'], timeout=20)
    if p is None or not p.stdout:
        return None
    found, pid, command = [], None, ''
    prefix = os.path.realpath(path).rstrip(os.sep) + os.sep
    for line in p.stdout.splitlines():
        if line.startswith('p'):
            pid, command = int(line[1:]), ''
        elif line.startswith('c'):
            command = line[1:]
        elif line.startswith('n') and pid is not None:
            where = os.path.realpath(line[1:])
            if (where + os.sep).startswith(prefix) and pid != os.getpid():
                found.append((pid, command))
    return found


def stop_processes(path, pids):
    """SIGTERM, then wait up to 4 seconds. Returns the pids that still hold a working directory in
    path; never escalates to SIGKILL.

    "Still running" is told by lsof, not by kill(pid, 0): a killed process its parent has not reaped
    yet still answers kill(pid, 0), but it no longer holds a working directory."""
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.time() + 4
    while True:
        time.sleep(0.3)
        holders = processes_in(path)
        alive = [pid for pid in pids if holders is not None and pid in set(p for p, _ in holders)]
        if not alive or time.time() > deadline:
            return alive


# ── cleanup ─────────────────────────────────────────────────────────────────

def cmd_cleanup(args):
    repo, run_dir, m = load(args)
    assumed = set(x.strip() for x in (args.assume_integrated or '').split(',') if x.strip())
    for n in assumed:
        item_number(n)
    known = worktrees(repo)
    main = m['main_worktree']
    current_branch = gout(main, 'symbolic-ref', '--short', '-q', 'HEAD')
    lines, skipped_any = [], False

    def note(level, key, **values):
        lines.append('%s %s' % (SYMBOL[level], _(key, **values)))

    for n in sorted(m['items'], key=int):
        item = m['items'][n]
        state = item_state(repo, m, n, item, known)
        label = item_label(n)
        if state['integration'] not in INTEGRATED and n not in assumed:
            note('warn', 'sub5.cleanup.not_integrated', item=label)
            skipped_any = True
            continue
        if n in assumed and state['integration'] not in INTEGRATED:
            note('info', 'sub5.cleanup.assumed', item=label)
        wt, branch = item['worktree'], item['branch']
        item_skipped = False

        if state['worktree_exists']:
            procs = processes_in(wt)
            if procs is None:
                note('info', 'sub5.cleanup.lsof_unavailable', item=label, path=wt)
            elif procs:
                shown = i18n.join(LOCALE, ('%s(pid %d)' % (c or '?', pid) for pid, c in procs))
                if args.stop_processes and not args.dry_run:
                    alive = stop_processes(wt, [pid for pid, _ in procs])
                    if alive:
                        note('warn', 'sub5.cleanup.still_alive', item=label, pids=i18n.join(LOCALE, alive))
                        item_skipped = True
                    else:
                        note('ok', 'sub5.cleanup.stopped', item=label, processes=shown)
                elif args.stop_processes:
                    note('info', 'sub5.cleanup.would_stop', item=label, processes=shown)
                else:
                    note('warn', 'sub5.cleanup.processes_running', item=label, processes=shown)
                    item_skipped = True

            if not item_skipped:
                if args.dry_run:
                    note('info', 'sub5.cleanup.would_remove_worktree', item=label, path=wt)
                else:
                    p = git(main, 'worktree', 'remove', wt)
                    if p is not None and p.returncode == 0:
                        note('ok', 'sub5.cleanup.removed_worktree', item=label, path=wt)
                    else:
                        reason = first_line(p.stderr if p else '') or _('sub5.cleanup.remove_failed')
                        note('warn', 'sub5.cleanup.worktree_kept', item=label, reason=reason)
                        item_skipped = True

        if not item_skipped and state['tip']:
            if branch == current_branch:
                note('warn', 'sub5.cleanup.current_branch', item=label, branch=branch)
                item_skipped = True
            elif args.dry_run:
                note('info', 'sub5.cleanup.would_delete_branch', item=label, branch=branch, sha=state['tip'][:7])
            else:
                p = git(main, 'branch', '-d', branch)
                if p is None or p.returncode != 0:
                    p = git(main, 'branch', '-D', branch)
                if p is not None and p.returncode == 0:
                    note('ok', 'sub5.cleanup.deleted_branch', item=label, branch=branch, sha=state['tip'][:7])
                else:
                    note('warn', 'sub5.cleanup.branch_kept', item=label, branch=branch, reason=first_line(p.stderr if p else ''))
                    item_skipped = True
        skipped_any = skipped_any or item_skipped

    if not args.dry_run:
        git(main, 'worktree', 'prune')
    if skipped_any or args.keep_base:
        note('info', 'sub5.cleanup.run_kept', run=m['run'])
        closed = False
    elif args.dry_run:
        note('info', 'sub5.cleanup.would_close', run=m['run'])
        closed = False
    else:
        gok(main, 'update-ref', '-d', m['base_ref'])
        shutil.rmtree(run_dir, ignore_errors=True)
        note('ok', 'sub5.cleanup.closed', run=m['run'])
        closed = True
    sys.stdout.write('\n'.join(lines) + '\n')
    return 0 if closed or args.dry_run else 1


# ── status ──────────────────────────────────────────────────────────────────

def cmd_status(args):
    repo = Repo(args.cwd)
    owned, runs = set(), []
    for base in stores(repo):
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            path = os.path.join(base, name, 'manifest.json')
            if os.path.isfile(path):
                with open(path, encoding='utf-8') as f:
                    m = json.load(f)
                runs.append(m)
                owned.update(os.path.realpath(i['worktree']) for i in m['items'].values())
    for m in runs:
        sys.stdout.write(_('sub5.status.run', run=m['run'], mode=m['mode'], base=m['base'][:7], count=len(m['items']), created=m['created_at']) + '\n')
    if not runs:
        sys.stdout.write(_('sub5.status.none') + '\n')
    strays = [(p, i['branch']) for p, i in worktrees(repo).items()
              if p not in owned and p != repo.root and ('/.claude/worktrees/' in p or (i['branch'] or '').startswith('refs/heads/sub5/'))]
    for path, branch in strays:
        sys.stdout.write('%s %s\n' % (SYMBOL['info'], _('sub5.status.stray', path=path, branch=branch or _('sub5.status.detached'))))
    return 0


# ── cli ─────────────────────────────────────────────────────────────────────

def build_parser():
    parser = argparse.ArgumentParser(prog='sub5.py', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--lang', help='language of the human-readable lines (default: env DECKHAND_LANG, else en)')
    sub = parser.add_subparsers(dest='command', required=True)

    def command(name, func, run=True):
        p = sub.add_parser(name)
        p.add_argument('--cwd', default=os.getcwd())
        p.add_argument('--lang', default=argparse.SUPPRESS, help='language of the human-readable lines')
        if run:
            p.add_argument('--run', required=name != 'base')
        p.set_defaults(func=func)
        return p

    command('base', cmd_base)
    p = command('register', cmd_register)
    p.add_argument('--item', required=True)
    p.add_argument('--branch', required=True)
    p.add_argument('--worktree', required=True)
    p.add_argument('--title', default='')
    p = command('apply', cmd_apply)
    p.add_argument('--item', required=True)
    p.add_argument('--three-way', action='store_true')
    p = command('check', cmd_check)
    p.add_argument('--format', choices=('text', 'json'), default='text')
    p = command('cleanup', cmd_cleanup)
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--assume-integrated', default='')
    p.add_argument('--stop-processes', action='store_true')
    p.add_argument('--keep-base', action='store_true')
    command('status', cmd_status, run=False)
    return parser


def main():
    global LOCALE
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    args = build_parser().parse_args()
    LOCALE = i18n.resolve(args.lang)
    try:
        sys.exit(args.func(args))
    except ToolError as error:
        sys.stderr.write('sub5: %s\n' % error.message)
        sys.exit(error.code)


if __name__ == '__main__':
    main()

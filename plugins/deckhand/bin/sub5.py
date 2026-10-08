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
"""
import argparse
import hashlib
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
            raise ToolError('這裡不在 git repo 內，Sub5 需要 git worktree。')
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
    raise ToolError('無法建立 Sub5 的暫存資料夾（%s 與暫存目錄都不可寫）。' % stores(repo)[0])


def save(run_dir, manifest):
    path = os.path.join(run_dir, 'manifest.json')
    fd, tmp = tempfile.mkstemp(dir=run_dir, prefix='.tmp-')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def load(args):
    repo = Repo(args.cwd)
    if not RUN_RE.match(args.run or ''):
        raise ToolError('run 的格式不對（應像 s5-20261007-130501）。')
    run_dir = find_run_dir(repo, args.run)
    if not run_dir:
        raise ToolError('找不到 run %s（已經清理完，或是在別的 repo）。' % args.run)
    with open(os.path.join(run_dir, 'manifest.json'), encoding='utf-8') as f:
        return repo, run_dir, json.load(f)


def item_number(value):
    if not ITEM_RE.match(str(value)):
        raise ToolError('item 必須是 1 到 99 的整數。')
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
                raise ToolError('建立快照失敗（git %s）：%s' % (args[0], first_line(p.stderr if p else '')))
        tree = gout(repo.top, 'write-tree', env=env)
        if not tree:
            raise ToolError('建立快照失敗（git write-tree）。')
        message = 'sub5 base snapshot (%s)' % run_id
        commit = gout(repo.top, 'commit-tree', tree, '-p', repo.head, '-m', message, env=env)
        if not commit:
            commit = gout(repo.top, 'commit-tree', tree, '-p', repo.head, '-m', message, env=dict(env, **IDENTITY))
        if not commit:
            raise ToolError('建立快照失敗（git commit-tree）：請確認 git 的 user.name 與 user.email 已設定。')
        return commit
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def cmd_base(args):
    repo = Repo(args.cwd)
    head = repo.head
    if not head:
        raise ToolError('這個 repo 還沒有任何 commit，請先建立一個 commit。')
    if in_progress(repo):
        raise ToolError('目前有進行中的 merge / rebase / cherry-pick，請先完成或中止，再按 Sub5。')
    run_id = args.run or time.strftime('s5-%Y%m%d-%H%M%S')
    if not RUN_RE.match(run_id):
        raise ToolError('run 的格式不對（應像 s5-20261007-130501）。')
    if find_run_dir(repo, run_id):
        raise ToolError('run %s 已經存在。' % run_id)

    lines = repo.status_lines() or []
    untracked = sum(1 for line in lines if line.startswith('??'))
    mode = 'dirty' if lines else 'clean'
    base = snapshot(repo, run_id) if mode == 'dirty' else head
    ref = 'refs/sub5/%s/base' % run_id
    if not gok(repo.top, 'update-ref', ref, base):
        raise ToolError('無法建立 %s。' % ref)

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
        'note': ('工作樹乾淨：base 就是 HEAD。' if mode == 'clean'
                 else '有未提交的成果：base 是快照 commit（不在你的分支上），你的分支、index 與工作樹沒有被動。'),
    })
    return 0


# ── register ────────────────────────────────────────────────────────────────

def cmd_register(args):
    repo, run_dir, m = load(args)
    n = item_number(args.item)
    if not gok(repo.top, 'check-ref-format', '--branch', args.branch):
        raise ToolError('分支名稱不合法：%s' % args.branch)
    tip = gout(repo.top, 'rev-parse', '--verify', '-q', 'refs/heads/' + args.branch)
    if not tip:
        raise ToolError('找不到分支 %s。worker 回報的分支名稱有誤，或它沒有任何變更（harness 會自動移除沒有變更的 worktree）。' % args.branch)
    wt = os.path.realpath(args.worktree)
    known = worktrees(repo)
    if wt not in known:
        raise ToolError('%s 不是這個 repo 的 worktree，不能登記。' % wt)
    if wt in (repo.root, os.path.realpath(m['main_worktree']), repo.top):
        raise ToolError('不能登記主工作樹。')
    on_branch = known[wt]['branch']
    if on_branch and on_branch != 'refs/heads/' + args.branch:
        raise ToolError('worktree %s 目前在 %s，不是 %s。' % (wt, on_branch, args.branch))
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


def describe(state):
    labels = {
        'merged': ('ok', '已整合（worker 分支已併入目前分支）'),
        'applied': ('ok', '已整合（變更已套用到工作樹）'),
        'empty': ('info', 'worker 沒有新 commit，沒有東西需要整合'),
        'missing': ('info', '分支已不存在（已清理，或 harness 已移除沒有變更的 worktree）'),
    }
    if state['integration'] in labels:
        level, text = labels[state['integration']]
    else:
        files = state['differing']
        text = '尚未整合' + ('：工作樹與 worker 版本不同的檔案 ' + '、'.join(files[:6]) + ('…共 %d 個' % len(files) if len(files) > 6 else '') if files else '')
        level = 'warn'
    extra = []
    if state['worktree_dirty']:
        extra.append('worktree 有 %d 項未提交的變更（請 worker 先 commit）' % state['worktree_dirty'])
    return level, '項目 %s%s：%s%s' % (state['item'], '「%s」' % state['title'] if state['title'] else '', text, '；' + '；'.join(extra) if extra else '')


# ── apply ───────────────────────────────────────────────────────────────────

def cmd_apply(args):
    repo, run_dir, m = load(args)
    n = item_number(args.item)
    if n not in m['items']:
        raise ToolError('項目 %s 還沒有登記（先執行 register）。' % n)
    item = m['items'][n]
    state = item_state(repo, m, n, item, worktrees(repo))
    if state['integration'] in ('merged', 'applied', 'empty'):
        sys.stdout.write('項目 %s：%s，不需要再套用。\n' % (n, describe(state)[1].split('：', 1)[-1]))
        return 0
    if not state['tip']:
        raise ToolError('項目 %s 的分支 %s 不存在。' % (n, item['branch']))
    if state['worktree_dirty']:
        sys.stdout.write('⚠ 項目 %s 的 worktree 還有 %d 項未提交的變更；這些不會被套用。\n' % (n, state['worktree_dirty']))
    main = m['main_worktree']
    patch = git(main, 'diff', '--binary', '--full-index', m['base'], state['tip'], binary=True)
    if patch is None or patch.returncode != 0:
        raise ToolError('無法產生項目 %s 的 diff。' % n)
    flags = ['--whitespace=nowarn'] + (['--3way'] if args.three_way else [])
    if not args.three_way:
        check = run(['git', 'apply', '--check'] + flags + ['-'], cwd=main, data=patch.stdout, binary=True)
        if check is None or check.returncode != 0:
            sys.stdout.write('✗ 項目 %s 無法乾淨地套用（工作樹沒有被改動）：\n%s\n' % (
                n, (check.stderr.decode('utf-8', 'replace').strip() if check else 'git apply 無法執行')))
            sys.stdout.write('可以手動整合，或加 --three-way 讓 git 嘗試三方合併（衝突會留下標記，並暫存相關檔案）。\n')
            return 1
    done = run(['git', 'apply'] + flags + ['-'], cwd=main, data=patch.stdout, binary=True)
    if done is None or done.returncode != 0:
        sys.stdout.write('✗ 項目 %s 套用失敗：\n%s\n' % (n, done.stderr.decode('utf-8', 'replace').strip() if done else ''))
        return 1
    item['applied_at'] = datetime.now().astimezone().isoformat(timespec='seconds')
    item['applied_tip'] = state['tip']
    save(run_dir, m)
    after = item_state(repo, m, n, item, worktrees(repo))
    sys.stdout.write('✓ 項目 %s 已套用到工作樹（未 commit）。核對結果：%s\n' % (n, describe(after)[1].split('：', 1)[-1]))
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
        sys.stdout.write('Sub5 檢查 %s（base %s · %s）\n' % (m['run'], m['base'][:7], m['mode']))
        if not states:
            sys.stdout.write('ℹ 還沒有登記任何項目。\n')
        for s in states:
            level, text = describe(s)
            sys.stdout.write('%s %s\n' % (SYMBOL[level], text))
        sys.stdout.write('結論：%s\n' % ('全部都已整合，可以清理' if not pending else '還有 %d 項尚未整合，不會被清理' % len(pending)))
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

    def note(level, text):
        lines.append('%s %s' % (SYMBOL[level], text))

    for n in sorted(m['items'], key=int):
        item = m['items'][n]
        state = item_state(repo, m, n, item, known)
        label = '項目 %s' % n
        if state['integration'] not in INTEGRATED and n not in assumed:
            note('warn', '%s：尚未整合，跳過（不會刪除任何東西）。' % label)
            skipped_any = True
            continue
        if n in assumed and state['integration'] not in INTEGRATED:
            note('info', '%s：依主 Agent 的確認視為已整合（--assume-integrated）。' % label)
        wt, branch = item['worktree'], item['branch']
        item_skipped = False

        if state['worktree_exists']:
            procs = processes_in(wt)
            if procs is None:
                note('info', '%s：無法檢查是否有程序仍在 %s 內執行（lsof 不可用）。' % (label, wt))
            elif procs:
                shown = '、'.join('%s(pid %d)' % (c or '?', pid) for pid, c in procs)
                if args.stop_processes and not args.dry_run:
                    alive = stop_processes(wt, [pid for pid, _ in procs])
                    if alive:
                        note('warn', '%s：已送出終止訊號，但仍有程序存活（pid %s），跳過移除 worktree。' % (label, '、'.join(map(str, alive))))
                        item_skipped = True
                    else:
                        note('ok', '%s：已停止 %s。' % (label, shown))
                elif args.stop_processes:
                    note('info', '%s：（試跑）會停止 %s。' % (label, shown))
                else:
                    note('warn', '%s：worktree 內仍有程序在執行：%s。確認是 worker 留下的之後，加 --stop-processes 重跑。' % (label, shown))
                    item_skipped = True

            if not item_skipped:
                if args.dry_run:
                    note('info', '%s：（試跑）會移除 worktree %s。' % (label, wt))
                else:
                    p = git(main, 'worktree', 'remove', wt)
                    if p is not None and p.returncode == 0:
                        note('ok', '%s：已移除 worktree %s。' % (label, wt))
                    else:
                        reason = first_line(p.stderr if p else '') or 'git worktree remove 失敗'
                        note('warn', '%s：沒有移除 worktree（%s）。不會強制刪除；請 worker 先 commit，或確認後自行處理。' % (label, reason))
                        item_skipped = True

        if not item_skipped and state['tip']:
            if branch == current_branch:
                note('warn', '%s：分支 %s 是目前所在的分支，跳過。' % (label, branch))
                item_skipped = True
            elif args.dry_run:
                note('info', '%s：（試跑）會刪除分支 %s（目前指向 %s）。' % (label, branch, state['tip'][:7]))
            else:
                p = git(main, 'branch', '-d', branch)
                if p is None or p.returncode != 0:
                    p = git(main, 'branch', '-D', branch)
                if p is not None and p.returncode == 0:
                    note('ok', '%s：已刪除分支 %s（原本指向 %s；要救回：git branch %s %s）。' % (label, branch, state['tip'][:7], branch, state['tip'][:7]))
                else:
                    note('warn', '%s：沒有刪除分支 %s（%s）。' % (label, branch, first_line(p.stderr if p else '')))
                    item_skipped = True
        skipped_any = skipped_any or item_skipped

    if not args.dry_run:
        git(main, 'worktree', 'prune')
    if skipped_any or args.keep_base:
        note('info', 'run %s 保留（base 與記錄還在），處理完跳過的項目後可以再執行 cleanup。' % m['run'])
        closed = False
    elif args.dry_run:
        note('info', '（試跑）全部乾淨時會刪除 base、暫存與記錄，結束 run %s。' % m['run'])
        closed = False
    else:
        gok(main, 'update-ref', '-d', m['base_ref'])
        shutil.rmtree(run_dir, ignore_errors=True)
        note('ok', 'run %s 已結束：base、暫存資料夾與記錄都已刪除。' % m['run'])
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
        sys.stdout.write('run %s · %s · base %s · %d 個項目 · %s\n' % (m['run'], m['mode'], m['base'][:7], len(m['items']), m['created_at']))
    if not runs:
        sys.stdout.write('目前沒有進行中的 Sub5 run。\n')
    strays = [(p, i['branch']) for p, i in worktrees(repo).items()
              if p not in owned and p != repo.root and ('/.claude/worktrees/' in p or (i['branch'] or '').startswith('refs/heads/sub5/'))]
    for path, branch in strays:
        sys.stdout.write('ℹ 未登記的 worktree（cleanup 不會處理）：%s（%s）\n' % (path, branch or '分離的 HEAD'))
    return 0


# ── cli ─────────────────────────────────────────────────────────────────────

def build_parser():
    parser = argparse.ArgumentParser(prog='sub5.py', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)

    def command(name, func, run=True):
        p = sub.add_parser(name)
        p.add_argument('--cwd', default=os.getcwd())
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
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    args = build_parser().parse_args()
    try:
        sys.exit(args.func(args))
    except ToolError as error:
        sys.stderr.write('sub5: %s\n' % error.message)
        sys.exit(error.code)


if __name__ == '__main__':
    main()

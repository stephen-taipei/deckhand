"""Tests for bin/sub5.py. Run: python3 -m unittest discover -s tests -p 'test_*.py'

Black-box: real git repos and real worktrees in a temp folder, git config isolated from the user's.
A "worker" is simulated the way the harness makes one: a new worktree on its own branch, then the
worker moves it onto the base (`git checkout -B <branch> <base>`) and commits.
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'bin', 'sub5.py')

spec = importlib.util.spec_from_file_location('sub5', SCRIPT)
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)

GIT_ENV = {
    'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
    'GIT_AUTHOR_NAME': 'T', 'GIT_AUTHOR_EMAIL': 't@example.com',
    'GIT_COMMITTER_NAME': 'T', 'GIT_COMMITTER_EMAIL': 't@example.com',
}

# `python -c AS_IF_NOT_POSIX script args...` runs the script with os.name as Windows reports it. The
# standard modules are loaded first, as on POSIX: some of them branch on os.name when imported.
AS_IF_NOT_POSIX = (
    'import argparse, datetime, hashlib, json, os, re, runpy, shutil, signal, subprocess, sys, tempfile, time\n'
    "os.name = 'nt'\n"
    'sys.argv = sys.argv[1:]\n'
    "runpy.run_path(sys.argv[0], run_name='__main__')\n"
)


def lsof_works():
    p = tool.run(['lsof', '-d', 'cwd', '-Fpn'], timeout=15)
    return p is not None and p.returncode in (0, 1) and ('n' + os.path.realpath(os.getcwd())) in p.stdout


class Sub5Case(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.env = dict(os.environ, TMPDIR=self.tmp, PYTHONDONTWRITEBYTECODE='1', **GIT_ENV)
        self.env.pop('DECKHAND_LANG', None)
        os.environ.update(GIT_ENV)
        self.repo = os.path.join(self.tmp, 'repo')
        os.makedirs(self.repo)
        self.git(self.repo, 'init', '-q', '-b', 'main')
        self.write(self.repo, 'a.txt', 'one\ntwo\nthree\n')
        self.write(self.repo, 'b.txt', 'bee\n')
        self.git(self.repo, 'add', '-A')
        self.git(self.repo, 'commit', '-q', '-m', 'first')
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            p.kill()
        subprocess.run(['rm', '-rf', self.tmp], check=False)

    def git(self, cwd, *args):
        done = subprocess.run(['git'] + list(args), cwd=cwd, env=self.env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.strip()

    def write(self, cwd, name, text):
        path = os.path.join(cwd, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            f.write(text)

    def read(self, cwd, name):
        with open(os.path.join(cwd, name)) as f:
            return f.read()

    def tool(self, *args, cwd=None, env=None):
        return subprocess.run([sys.executable, SCRIPT] + list(args), cwd=cwd or self.repo, env=dict(self.env, **(env or {})),
                              capture_output=True, text=True, encoding='utf-8')

    def base(self):
        done = self.tool('base')
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def worker(self, run, n, edits, base, branch=None, commit=True):
        """A worktree as the harness gives one, moved onto the base by the worker, with edits committed."""
        branch = branch or 'worktree-agent-%d' % n
        wt = os.path.join(self.tmp, 'wt%d' % n)
        self.git(self.repo, 'worktree', 'add', '-q', '-b', branch, wt, 'HEAD')
        self.git(wt, 'checkout', '-q', '-B', branch, base)
        for name, text in edits.items():
            if text is None:
                os.remove(os.path.join(wt, name))
            else:
                self.write(wt, name, text)
        if commit:
            self.git(wt, 'add', '-A')
            self.git(wt, 'commit', '-q', '-m', 'item %d' % n)
        return wt, branch

    def register(self, run, n, wt, branch, title='t'):
        done = self.tool('register', '--run', run, '--item', str(n), '--branch', branch, '--worktree', wt, '--title', title)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def branches(self):
        return self.git(self.repo, 'branch', '--format=%(refname:short)').split()

    def status(self, cwd=None):
        return self.git(cwd or self.repo, 'status', '--porcelain')


class BaseTests(Sub5Case):
    def test_clean_tree_uses_head_as_the_base(self):
        out = self.base()
        self.assertEqual((out['mode'], out['base']), ('clean', self.git(self.repo, 'rev-parse', 'HEAD')))
        self.assertTrue(re.match(r's5-\d{8}-\d{6}$', out['run']))
        self.assertEqual(self.git(self.repo, 'rev-parse', 'refs/sub5/%s/base' % out['run']), out['base'])
        self.assertTrue(os.path.isfile(out['manifest']))
        self.assertTrue(os.path.isdir(out['scratch']))

    def test_uncommitted_work_is_snapshotted_without_touching_branch_index_or_tree(self):
        self.write(self.repo, 'a.txt', 'one\nTWO\nthree\n')            # modified, unstaged
        self.write(self.repo, 'b.txt', 'bee\nbuzz\n')
        self.git(self.repo, 'add', 'b.txt')                              # staged
        self.write(self.repo, 'new.txt', 'brand new\n')                  # untracked
        self.write(self.repo, '.gitignore', 'ignored.log\n')
        self.write(self.repo, 'ignored.log', 'noise\n')
        head, status, branches = self.git(self.repo, 'rev-parse', 'HEAD'), self.status(), self.branches()
        out = self.base()
        self.assertEqual(out['mode'], 'dirty')
        self.assertNotEqual(out['base'], head)
        self.assertEqual(self.git(self.repo, 'rev-parse', out['base'] + '^'), head)
        # the snapshot holds everything the working tree holds, minus what is ignored
        self.assertEqual(self.git(self.repo, 'show', out['base'] + ':a.txt'), 'one\nTWO\nthree')
        self.assertEqual(self.git(self.repo, 'show', out['base'] + ':new.txt'), 'brand new')
        self.assertEqual(self.git(self.repo, 'ls-tree', '--name-only', out['base']).split().count('ignored.log'), 0)
        # and nothing of the user's moved
        self.assertEqual((self.git(self.repo, 'rev-parse', 'HEAD'), self.status(), self.branches()), (head, status, branches))
        self.assertEqual(out['wip'], {'tracked': 2, 'untracked': 2})        # a.txt, b.txt; new.txt, .gitignore (ignored.log is not counted)

    def test_refuses_outside_git_without_a_commit_and_mid_merge(self):
        plain = os.path.join(self.tmp, 'plain')
        os.makedirs(plain)
        self.assertEqual(self.tool('base', cwd=plain).returncode, 2)
        empty = os.path.join(self.tmp, 'empty')
        os.makedirs(empty)
        self.git(empty, 'init', '-q')
        self.assertIn('commit', self.tool('base', cwd=empty).stderr)
        self.git(self.repo, 'checkout', '-q', '-b', 'side')
        self.write(self.repo, 'a.txt', 'side\n')
        self.git(self.repo, 'commit', '-qam', 'side')
        self.git(self.repo, 'checkout', '-q', 'main')
        self.write(self.repo, 'a.txt', 'main\n')
        self.git(self.repo, 'commit', '-qam', 'main')
        subprocess.run(['git', 'merge', 'side'], cwd=self.repo, env=self.env, capture_output=True)   # conflicts
        self.assertIn('merge', self.tool('base').stderr)

    def test_manifest_falls_back_to_the_temp_folder_when_the_repo_one_is_unwritable(self):
        open(os.path.join(self.repo, '.git', 'deckhand-sub5'), 'w').close()    # a file where the folder would go
        out = self.base()
        self.assertTrue(out['manifest'].startswith(self.tmp + os.sep + 'deckhand-sub5'))
        wt, br = self.worker(out['run'], 1, {'a.txt': 'x\n'}, out['base'])
        self.register(out['run'], 1, wt, br)
        self.assertEqual(self.tool('check', '--run', out['run']).returncode, 1)


class RegisterTests(Sub5Case):
    def test_registers_a_worker_and_reports_what_it_made(self):
        out = self.base()
        wt, br = self.worker(out['run'], 1, {'a.txt': 'one\ntwo\nfour\n'}, out['base'])
        info = self.register(out['run'], 1, wt, br)
        self.assertEqual((info['commits'], info['worktree_dirty'], info['base_is_ancestor']), (1, 0, True))

    def test_only_worktrees_of_this_repo_and_never_the_main_checkout(self):
        out = self.base()
        wt, br = self.worker(out['run'], 1, {'a.txt': 'x\n'}, out['base'])
        elsewhere = os.path.join(self.tmp, 'not-a-worktree')
        os.makedirs(elsewhere)
        for path, branch in ((elsewhere, br), (self.repo, 'main')):
            done = self.tool('register', '--run', out['run'], '--item', '1', '--branch', branch, '--worktree', path)
            self.assertEqual(done.returncode, 2, done.stdout)
        done = self.tool('register', '--run', out['run'], '--item', '1', '--branch', 'no-such-branch', '--worktree', wt)
        self.assertEqual(done.returncode, 2)
        done = self.tool('register', '--run', out['run'], '--item', '100', '--branch', br, '--worktree', wt)
        self.assertEqual(done.returncode, 2)

    def test_a_dirty_worker_worktree_is_reported(self):
        out = self.base()
        wt, br = self.worker(out['run'], 1, {'a.txt': 'x\n'}, out['base'], commit=False)
        self.assertEqual(self.register(out['run'], 1, wt, br)['worktree_dirty'], 1)


class ApplyAndCheckTests(Sub5Case):
    def test_apply_puts_the_worker_changes_in_the_working_tree_without_committing_or_staging(self):
        self.write(self.repo, 'wip.txt', 'work in progress\n')          # the task's uncommitted result
        out = self.base()
        wt, br = self.worker(out['run'], 1, {'a.txt': 'one\ntwo\nfour\n', 'docs/new.md': 'doc\n', 'b.txt': None}, out['base'])
        self.register(out['run'], 1, wt, br)
        self.assertEqual(self.tool('check', '--run', out['run']).returncode, 1)         # pending before
        head, branches = self.git(self.repo, 'rev-parse', 'HEAD'), self.branches()
        done = self.tool('apply', '--run', out['run'], '--item', '1')
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.read(self.repo, 'a.txt'), 'one\ntwo\nfour\n')
        self.assertEqual(self.read(self.repo, 'docs/new.md'), 'doc\n')
        self.assertFalse(os.path.exists(os.path.join(self.repo, 'b.txt')))
        self.assertEqual(self.read(self.repo, 'wip.txt'), 'work in progress\n')             # the user's own work is still there
        self.assertEqual(self.git(self.repo, 'rev-parse', 'HEAD'), head)                    # no commit on the user's branch
        self.assertEqual(self.git(self.repo, 'diff', '--cached', '--name-only'), '')        # nothing staged
        self.assertEqual(self.branches(), branches)
        checked = self.tool('check', '--run', out['run'])
        self.assertEqual(checked.returncode, 0, checked.stdout)
        self.assertIn('integrated (the changes are applied to the working tree)', checked.stdout)

    def test_a_patch_that_does_not_apply_leaves_the_tree_untouched(self):
        out = self.base()
        wt, br = self.worker(out['run'], 1, {'a.txt': 'one\nTWO\nthree\n', 'b.txt': 'bee\nbuzz\n'}, out['base'])
        self.register(out['run'], 1, wt, br)
        self.write(self.repo, 'a.txt', 'one\nsomething else\nthree\n')       # the user edited the same line meanwhile
        before = (self.read(self.repo, 'a.txt'), self.read(self.repo, 'b.txt'), self.status())
        done = self.tool('apply', '--run', out['run'], '--item', '1')
        self.assertEqual(done.returncode, 1)
        self.assertIn('the working tree was not changed', done.stdout)
        self.assertEqual((self.read(self.repo, 'a.txt'), self.read(self.repo, 'b.txt'), self.status()), before)

    def test_check_lists_the_files_that_still_differ(self):
        out = self.base()
        wt, br = self.worker(out['run'], 1, {'a.txt': 'x\n', 'b.txt': 'y\n'}, out['base'])
        self.register(out['run'], 1, wt, br)
        done = self.tool('check', '--run', out['run'])
        self.assertEqual(done.returncode, 1)
        self.assertIn('a.txt', done.stdout)
        self.assertIn('b.txt', done.stdout)
        self.assertEqual(json.loads(self.tool('check', '--run', out['run'], '--format', 'json').stdout)['items'][0]['integration'], 'pending')

    def test_a_merged_branch_and_an_empty_worker_count_as_done(self):
        out = self.base()
        wt1, br1 = self.worker(out['run'], 1, {'a.txt': 'merged\n'}, out['base'])
        wt2, br2 = self.worker(out['run'], 2, {}, out['base'], commit=False)
        self.register(out['run'], 1, wt1, br1)
        self.register(out['run'], 2, wt2, br2)
        self.git(self.repo, 'merge', '-q', '--no-edit', br1)
        states = {i['item']: i['integration'] for i in json.loads(self.tool('check', '--run', out['run'], '--format', 'json').stdout)['items']}
        self.assertEqual(states, {'1': 'merged', '2': 'empty'})
        self.assertEqual(self.tool('check', '--run', out['run']).returncode, 0)

    def test_applying_twice_is_harmless(self):
        out = self.base()
        wt, br = self.worker(out['run'], 1, {'a.txt': 'once\n'}, out['base'])
        self.register(out['run'], 1, wt, br)
        self.assertEqual(self.tool('apply', '--run', out['run'], '--item', '1').returncode, 0)
        again = self.tool('apply', '--run', out['run'], '--item', '1')
        self.assertEqual(again.returncode, 0)
        self.assertEqual(self.read(self.repo, 'a.txt'), 'once\n')

    def test_a_worktree_with_uncommitted_work_is_called_out(self):
        out = self.base()
        wt, br = self.worker(out['run'], 1, {'a.txt': 'x\n'}, out['base'])
        self.register(out['run'], 1, wt, br)
        self.write(wt, 'forgotten.txt', 'not committed\n')
        self.assertIn('1 uncommitted change(s)', self.tool('check', '--run', out['run']).stdout)


class CleanupTests(Sub5Case):
    def integrated_run(self):
        out = self.base()
        wt, br = self.worker(out['run'], 1, {'a.txt': 'done\n'}, out['base'])
        self.register(out['run'], 1, wt, br)
        self.assertEqual(self.tool('apply', '--run', out['run'], '--item', '1').returncode, 0)
        return out, wt, br

    def test_removes_what_the_run_made_and_closes_it(self):
        out, wt, br = self.integrated_run()
        done = self.tool('cleanup', '--run', out['run'])
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertFalse(os.path.exists(wt))
        self.assertNotIn(br, self.branches())
        self.assertEqual(subprocess.run(['git', 'rev-parse', '-q', '--verify', 'refs/sub5/%s/base' % out['run']], cwd=self.repo, env=self.env, capture_output=True).returncode, 1)
        self.assertFalse(os.path.exists(os.path.dirname(out['manifest'])))
        self.assertIn('deleted branch', done.stdout)
        self.assertEqual(self.read(self.repo, 'a.txt'), 'done\n')                           # the integrated work stays
        self.assertEqual(self.tool('check', '--run', out['run']).returncode, 2)             # the run is gone

    def test_a_deleted_branch_can_be_brought_back_from_the_printed_sha(self):
        out, wt, br = self.integrated_run()
        tip = self.git(self.repo, 'rev-parse', br)
        self.assertIn('git branch %s %s' % (br, tip[:7]), self.tool('cleanup', '--run', out['run']).stdout)
        self.git(self.repo, 'branch', 'rescued', tip[:7])
        self.assertEqual(self.git(self.repo, 'show', 'rescued:a.txt'), 'done')

    def test_an_unintegrated_item_deletes_nothing(self):
        out = self.base()
        wt, br = self.worker(out['run'], 1, {'a.txt': 'not applied\n'}, out['base'])
        self.register(out['run'], 1, wt, br)
        done = self.tool('cleanup', '--run', out['run'])
        self.assertEqual(done.returncode, 1)
        self.assertIn('not integrated yet', done.stdout)
        self.assertTrue(os.path.isdir(wt))
        self.assertIn(br, self.branches())
        self.assertTrue(os.path.isfile(out['manifest']))

    def test_a_dirty_worktree_is_never_forced(self):
        out, wt, br = self.integrated_run()
        self.write(wt, 'forgotten.txt', 'precious\n')
        done = self.tool('cleanup', '--run', out['run'])
        self.assertEqual(done.returncode, 1)
        self.assertIn('never forced', done.stdout)
        self.assertEqual(self.read(wt, 'forgotten.txt'), 'precious\n')
        self.assertIn(br, self.branches())

    def test_assume_integrated_lets_the_main_agent_vouch_for_hand_edited_work(self):
        out, wt, br = self.integrated_run()
        self.write(self.repo, 'a.txt', 'done, then fixed by hand\n')        # the main agent edited after applying
        self.assertEqual(self.tool('cleanup', '--run', out['run'], '--dry-run').returncode, 0)
        self.assertEqual(self.tool('cleanup', '--run', out['run']).returncode, 1)          # still refused without the flag
        self.assertTrue(os.path.isdir(wt))
        done = self.tool('cleanup', '--run', out['run'], '--assume-integrated', '1')
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertFalse(os.path.exists(wt))

    def test_dry_run_changes_nothing(self):
        out, wt, br = self.integrated_run()
        done = self.tool('cleanup', '--run', out['run'], '--dry-run')
        self.assertEqual(done.returncode, 0)
        self.assertIn('(dry run)', done.stdout)
        self.assertTrue(os.path.isdir(wt))
        self.assertIn(br, self.branches())
        self.assertTrue(os.path.isfile(out['manifest']))

    def test_what_the_run_does_not_own_is_left_alone(self):
        out, wt, br = self.integrated_run()
        self.git(self.repo, 'branch', 'decoy')
        decoy = os.path.join(self.tmp, 'decoy-wt')
        self.git(self.repo, 'worktree', 'add', '-q', '-b', 'decoy-wt-branch', decoy, 'HEAD')
        self.assertEqual(self.tool('cleanup', '--run', out['run']).returncode, 0)
        self.assertIn('decoy', self.branches())
        self.assertIn('decoy-wt-branch', self.branches())
        self.assertTrue(os.path.isdir(decoy))

    def test_the_branch_you_are_on_is_never_deleted(self):
        out = self.base()
        wt, br = self.worker(out['run'], 1, {'a.txt': 'x\n'}, out['base'], branch='main-copy')
        self.register(out['run'], 1, wt, br)
        # the worktree goes by hand so that the branch can be checked out in the main checkout: it is merged then
        self.git(self.repo, 'worktree', 'remove', '--force', wt)
        self.git(self.repo, 'checkout', '-q', 'main-copy')
        done = self.tool('cleanup', '--run', out['run'])
        self.assertIn('the branch you are on', done.stdout)
        self.assertIn('main-copy', self.branches())
        self.assertEqual(self.git(self.repo, 'branch', '--show-current'), 'main-copy')

    @unittest.skipUnless(lsof_works(), 'lsof cannot list working directories here')
    def test_a_process_still_running_in_the_worktree_blocks_removal_until_asked(self):
        out, wt, br = self.integrated_run()
        proc = subprocess.Popen(['sleep', '60'], cwd=wt)
        self.procs.append(proc)
        done = self.tool('cleanup', '--run', out['run'])
        self.assertEqual(done.returncode, 1)
        self.assertIn('still running', done.stdout)
        self.assertTrue(os.path.isdir(wt))
        done = self.tool('cleanup', '--run', out['run'], '--stop-processes')
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertFalse(os.path.exists(wt))
        proc.wait(timeout=10)


class StatusTests(Sub5Case):
    def test_lists_runs_and_flags_unowned_worker_worktrees(self):
        self.assertIn('No Sub5 run in progress', self.tool('status').stdout)
        out = self.base()
        stray = os.path.join(self.repo, '.claude', 'worktrees', 'agent-zz')
        self.git(self.repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-zz', stray, 'HEAD')
        shown = self.tool('status').stdout
        self.assertIn(out['run'], shown)
        self.assertIn('Unregistered worktree', shown)
        self.assertIn('agent-zz', shown)


class LanguageTests(Sub5Case):
    def pending_run(self):
        out = self.base()
        wt, br = self.worker(out['run'], 1, {'a.txt': 'x\n'}, out['base'])
        self.register(out['run'], 1, wt, br, title='docs')
        return out, wt, br

    def test_check_speaks_the_language_asked_for(self):
        out, wt, br = self.pending_run()
        self.assertEqual(self.tool('apply', '--run', out['run'], '--item', '1').returncode, 0)
        done = self.tool('check', '--run', out['run'], '--lang', 'zh-TW')
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertIn('Sub5 檢查 %s（base %s · clean）' % (out['run'], out['base'][:7]), done.stdout)
        self.assertIn('✓ 項目 1「docs」：已整合（變更已套用到工作樹）', done.stdout)
        self.assertIn('結論：全部都已整合，可以清理', done.stdout)
        en = self.tool('check', '--run', out['run']).stdout
        self.assertIn('✓ Item 1 "docs": integrated (the changes are applied to the working tree)', en)

    def test_deckhand_lang_is_used_and_the_flag_wins(self):
        self.assertIn('進行中の Sub5 run はありません', self.tool('status', env={'DECKHAND_LANG': 'ja'}).stdout)
        self.assertIn('진행 중인 Sub5 run이 없습니다', self.tool('status', '--lang', 'ko', env={'DECKHAND_LANG': 'ja'}).stdout)
        self.assertIn('No Sub5 run in progress', self.tool('--lang', 'en', 'status', env={'DECKHAND_LANG': 'ja'}).stdout)

    def test_errors_follow_the_language_and_keep_their_exit_code(self):
        plain = os.path.join(self.tmp, 'plain')
        os.makedirs(plain)
        done = self.tool('base', '--lang', 'zh-CN', cwd=plain)
        self.assertEqual(done.returncode, 2)
        self.assertIn('不在 git 仓库中', done.stderr)
        done = self.tool('check', '--run', 'bad', '--lang', 'ja')
        self.assertEqual(done.returncode, 2)
        self.assertIn('run ID の形式が正しくありません', done.stderr)

    def test_json_output_does_not_change_with_the_language(self):
        out, wt, br = self.pending_run()
        outs = {lang: self.tool('check', '--run', out['run'], '--format', 'json', '--lang', lang) for lang in ('en', 'zh-TW', 'ko')}
        self.assertEqual({o.returncode for o in outs.values()}, {1})
        self.assertEqual(len({o.stdout for o in outs.values()}), 1, 'the JSON of check is the same in every language')
        self.assertEqual(json.loads(outs['ko'].stdout)['items'][0]['integration'], 'pending')

    def test_base_json_keeps_its_fields_and_only_the_note_is_translated(self):
        en = json.loads(self.tool('base').stdout)
        self.write(self.repo, 'a.txt', 'changed\n')
        zh = json.loads(self.tool('base', '--run', 's5-20990101-000001', '--lang', 'zh-TW').stdout)
        self.assertEqual(sorted(en), sorted(zh))
        self.assertEqual((en['mode'], zh['mode']), ('clean', 'dirty'))
        self.assertEqual(en['note'], 'The working tree is clean: the base is HEAD.')
        self.assertTrue(zh['note'].startswith('有未提交的成果'))

    def test_a_system_other_than_macos_or_linux_is_refused_before_anything_is_made(self):
        for args, lang, words in (
            (['base'], 'en', 'Deckhand runs on macOS and Linux only'),
            (['status'], 'zh-TW', 'Deckhand 只支援 macOS 和 Linux'),
            (['cleanup', '--run', 's5-20990101-000001'], 'zh-CN', 'Deckhand 仅支持 macOS 和 Linux'),
        ):
            with self.subTest(args=args[0]):
                done = subprocess.run([sys.executable, '-c', AS_IF_NOT_POSIX, SCRIPT] + args + ['--lang', lang], cwd=self.repo,
                                      env=self.env, capture_output=True, text=True, encoding='utf-8')
                self.assertEqual(done.returncode, 2, done.stderr)
                self.assertEqual(done.stdout, '')
                self.assertEqual(len(done.stderr.strip().splitlines()), 1, done.stderr)
                self.assertTrue(done.stderr.startswith('sub5: '), done.stderr)
                self.assertIn(words, done.stderr)
        self.assertEqual(self.git(self.repo, 'for-each-ref', '--format=%(refname)'), 'refs/heads/main')
        self.assertFalse(os.path.exists(os.path.join(self.repo, '.git', 'deckhand-sub5')))
        self.assertEqual(self.status(), '')

    def test_cleanup_lines_in_another_language(self):
        out, wt, br = self.pending_run()
        done = self.tool('cleanup', '--run', out['run'], '--lang', 'zh-TW')
        self.assertEqual(done.returncode, 1)
        self.assertIn('⚠ 項目 1：尚未整合，跳過（不會刪除任何東西）。', done.stdout)
        self.assertIn('run %s 保留' % out['run'], done.stdout)


if __name__ == '__main__':
    unittest.main()

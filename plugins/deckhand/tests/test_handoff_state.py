"""Tests for bin/handoff-state.py. Run: python3 -m unittest discover -s tests -p 'test_*.py'

Black-box: each test builds real git repos in a temp folder and runs the CLI
against them, with AGENT_HANDOFF_DIR and the git config isolated from the user's.
"""
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'bin', 'handoff-state.py')

spec = importlib.util.spec_from_file_location('handoff_state', SCRIPT)
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)

GIT_ENV = {
    'GIT_CONFIG_GLOBAL': os.devnull,
    'GIT_CONFIG_NOSYSTEM': '1',
    'GIT_AUTHOR_NAME': 'T',
    'GIT_AUTHOR_EMAIL': 't@example.com',
    'GIT_COMMITTER_NAME': 'T',
    'GIT_COMMITTER_EMAIL': 't@example.com',
}


class Workspace(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.handoffs = os.path.join(self.tmp, 'handoffs')
        self.env = dict(os.environ, AGENT_HANDOFF_DIR=self.handoffs, **GIT_ENV)

    def tearDown(self):
        subprocess.run(['rm', '-rf', self.tmp], check=False)

    def git(self, cwd, *args):
        done = subprocess.run(['git'] + list(args), cwd=cwd, env=self.env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.strip()

    def repo(self, name='repo', parent=None):
        path = os.path.join(parent or self.tmp, name)
        os.makedirs(path)
        self.git(path, 'init', '-q', '-b', 'main')
        self.commit(path, 'first')
        return path

    def commit(self, path, message, filename='a.txt'):
        with open(os.path.join(path, filename), 'a') as f:
            f.write(message + '\n')
        self.git(path, 'add', '-A')
        self.git(path, 'commit', '-q', '-m', message)

    def tool(self, *args, cwd=None, stdin=None):
        return subprocess.run(
            [sys.executable, SCRIPT] + list(args), cwd=cwd or self.tmp, env=self.env,
            input=stdin, capture_output=True, text=True, encoding='utf-8',
        )

    def write(self, cwd, narrative='## 目標\n接手測試\n', source='claude', target='codex'):
        done = self.tool('write', '--from', source, '--to', target, '--cwd', cwd, '--no-pr', stdin=narrative)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def check(self, cwd, source='claude', target='codex', fmt='text'):
        return self.tool('check', '--from', source, '--to', target, '--cwd', cwd, '--no-pr', '--format', fmt)


class StateTests(Workspace):
    def test_worktree_maps_to_the_main_repo_folder(self):
        main = self.repo('main-repo')
        wt = os.path.join(self.tmp, 'wt')
        self.git(main, 'worktree', 'add', '-q', wt, '-b', 'feature')
        state = json.loads(self.tool('state', '--format', 'json', '--no-pr', '--cwd', wt).stdout)
        self.assertEqual(state['project'], 'main-repo')
        self.assertEqual(state['repo_root'], main)
        self.assertEqual(state['worktree'], wt)
        self.assertEqual(state['branch'], 'feature')
        self.assertEqual(state['head'], self.git(wt, 'rev-parse', 'HEAD'))

    def test_remote_credentials_are_dropped(self):
        repo = self.repo()
        self.git(repo, 'remote', 'add', 'origin', 'https://user:tok3nvalue@github.com/o/r.git')
        state = json.loads(self.tool('state', '--format', 'json', '--no-pr', '--cwd', repo).stdout)
        self.assertEqual(state['remote_origin'], 'https://github.com/o/r.git')

    def test_counts_dirty_and_untracked_files(self):
        repo = self.repo()
        with open(os.path.join(repo, 'a.txt'), 'a') as f:
            f.write('change\n')
        open(os.path.join(repo, 'new.txt'), 'w').close()
        state = json.loads(self.tool('state', '--format', 'json', '--no-pr', '--cwd', repo).stdout)
        self.assertEqual((state['dirty_files'], state['untracked_files']), (1, 1))
        self.assertNotIn('_changed', state)

    def test_a_folder_outside_git_is_described_without_git_facts(self):
        plain = os.path.join(self.tmp, 'notes')
        os.makedirs(plain)
        state = json.loads(self.tool('state', '--format', 'json', '--no-pr', '--cwd', plain).stdout)
        self.assertEqual((state['git'], state['project']), ('false', 'notes'))
        self.assertNotIn('head', state)

    def test_front_matter_is_flat_key_value_lines(self):
        repo = self.repo()
        out = self.tool('state', '--no-pr', '--cwd', repo, '--from', 'codex').stdout.splitlines()
        self.assertEqual((out[0], out[-1]), ('---', '---'))
        fields, _ = tool.parse_front_matter('\n'.join(out) + '\n\nbody')
        self.assertEqual(fields['from'], 'codex')
        self.assertEqual(fields['branch'], 'main')


class WriteTests(Workspace):
    def test_writes_dated_and_latest_files_privately(self):
        repo = self.repo()
        result = self.write(repo)
        self.assertTrue(os.path.basename(result['path']).endswith('-claude-to-codex.md'))
        self.assertEqual(os.path.dirname(result['path']), os.path.join(self.handoffs, 'repo'))
        with open(result['path'], encoding='utf-8') as a, open(result['latest'], encoding='utf-8') as b:
            dated, latest = a.read(), b.read()
        self.assertEqual(dated, latest)
        self.assertTrue(dated.startswith('---\n'))
        self.assertIn('branch: main', dated)
        self.assertIn('## 目標\n接手測試', dated)
        self.assertEqual(stat.S_IMODE(os.stat(result['path']).st_mode), 0o600)
        self.assertIn('check --from claude --to codex', result['next_prompt'])

    def test_a_second_handoff_in_the_same_minute_does_not_overwrite(self):
        repo = self.repo()
        first, second = self.write(repo), self.write(repo, narrative='## 目標\n第二份\n')
        self.assertNotEqual(first['path'], second['path'])
        self.assertTrue(second['path'].endswith('-2.md'))
        with open(first['path'], encoding='utf-8') as f:
            self.assertIn('接手測試', f.read())

    def test_secrets_are_masked_and_counted(self):
        repo = self.repo()
        narrative = '## 風險\nGITHUB_TOKEN=abcdef1234567890abcd\ntoken ghp_abcdefghijklmnopqrstuvwxyz123456\n'
        result = self.write(repo, narrative)
        self.assertEqual(result['redacted'], 2)
        with open(result['path'], encoding='utf-8') as f:
            text = f.read()
        self.assertNotIn('abcdef1234567890abcd', text)
        self.assertNotIn('ghp_abcdefghij', text)
        self.assertIn('GITHUB_TOKEN=<REDACTED>', text)

    def test_a_front_matter_the_agent_wrote_itself_is_replaced(self):
        repo = self.repo()
        result = self.write(repo, '---\nbranch: made-up\nhead: 0000000\n---\n\n## 目標\n真的內容\n')
        with open(result['path'], encoding='utf-8') as f:
            text = f.read()
        self.assertNotIn('made-up', text)
        self.assertEqual(text.count('\n---\n'), 1)
        self.assertIn('真的內容', text)

    def test_empty_narrative_and_same_direction_are_refused(self):
        repo = self.repo()
        self.assertEqual(self.tool('write', '--from', 'claude', '--to', 'codex', '--cwd', repo, stdin='  \n').returncode, 2)
        self.assertNotEqual(self.tool('write', '--from', 'codex', '--to', 'codex', '--cwd', repo, stdin='x').returncode, 0)


class CheckTests(Workspace):
    def test_unchanged_repo_is_consistent(self):
        repo = self.repo()
        self.write(repo)
        done = self.check(repo)
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertIn('結論：與交接文件一致', done.stdout)

    def test_new_commits_are_counted(self):
        repo = self.repo()
        self.write(repo)
        self.commit(repo, 'second')
        done = self.check(repo)
        self.assertEqual(done.returncode, 1)
        self.assertIn('HEAD 已前進', done.stdout)
        self.assertIn('多了 1 個 commit：second', done.stdout)

    def test_uncommitted_changes_are_reported_with_paths(self):
        repo = self.repo()
        self.write(repo)
        with open(os.path.join(repo, 'a.txt'), 'a') as f:
            f.write('edit\n')
        done = self.check(repo)
        self.assertEqual(done.returncode, 1)
        self.assertIn('未提交變更不同：tracked 0→1', done.stdout)
        self.assertIn('a.txt', done.stdout)

    def test_a_different_branch_is_reported(self):
        repo = self.repo()
        self.write(repo)
        self.git(repo, 'checkout', '-q', '-b', 'other')
        done = self.check(repo)
        self.assertIn('分支不同：交接時 main，現在 other', done.stdout)

    def test_amend_reads_as_diverged_history(self):
        repo = self.repo()
        self.write(repo)
        self.git(repo, 'commit', '-q', '--amend', '-m', 'rewritten')
        done = self.check(repo)
        self.assertEqual(done.returncode, 1)
        self.assertIn('HEAD 歷史已分岔', done.stdout)

    def test_going_back_reads_as_behind(self):
        repo = self.repo()
        self.commit(repo, 'second')
        self.write(repo)
        self.git(repo, 'reset', '-q', '--hard', 'HEAD~1')
        self.assertIn('HEAD 落後交接點', self.check(repo).stdout)

    def test_same_folder_name_in_another_place_is_an_error(self):
        a = self.repo('repo', parent=os.path.join(self.tmp, 'a'))
        b = self.repo('repo', parent=os.path.join(self.tmp, 'b'))
        self.write(a)
        done = self.check(b)
        self.assertEqual(done.returncode, 1)
        self.assertIn('✗ 專案不同', done.stdout)

    def test_another_worktree_of_the_same_repo_is_info_not_error(self):
        main = self.repo('main-repo')
        self.write(main)
        wt = os.path.join(self.tmp, 'wt')
        self.git(main, 'worktree', 'add', '-q', wt, '-b', 'feature')
        done = self.check(wt)
        self.assertIn('ℹ worktree 不同', done.stdout)
        self.assertIn('分支不同', done.stdout)

    def test_missing_file_exits_2(self):
        repo = self.repo()
        done = self.check(repo)
        self.assertEqual(done.returncode, 2)
        self.assertEqual(json.loads(self.check(repo, fmt='json').stdout)['error'], 'missing')

    def test_a_file_without_front_matter_exits_2(self):
        repo = self.repo()
        path = os.path.join(self.handoffs, 'repo')
        os.makedirs(path)
        with open(os.path.join(path, 'latest-claude-to-codex.md'), 'w') as f:
            f.write('just prose\n')
        self.assertEqual(self.check(repo).returncode, 2)

    def test_a_hostile_head_value_never_reaches_git_as_an_option(self):
        repo = self.repo()
        result = self.write(repo)
        for name in (result['path'], result['latest']):
            with open(name, encoding='utf-8') as f:
                text = f.read()
            with open(name, 'w', encoding='utf-8') as f:
                f.write(text.replace('head: ' + result['state']['head'], 'head: --upload-pack=touch-pwned'))
        done = self.check(repo)
        self.assertEqual(done.returncode, 1)
        self.assertIn('找不到', done.stdout)
        self.assertFalse(os.path.exists(os.path.join(repo, 'touch-pwned')))

    def test_json_prompt_lists_only_the_differences(self):
        repo = self.repo()
        self.write(repo)
        self.commit(repo, 'second')
        out = json.loads(self.check(repo, fmt='json').stdout)
        self.assertEqual(out['differences'], 1)
        self.assertIn('HEAD 已前進', out['next_prompt'])
        self.assertNotIn('專案相同', out['next_prompt'])
        self.assertIn(out['path'], out['next_prompt'])

    def test_reading_direction_uses_the_other_file(self):
        repo = self.repo()
        self.write(repo, source='codex', target='claude')
        self.assertEqual(self.check(repo, source='codex', target='claude').returncode, 0)
        self.assertEqual(self.check(repo, source='claude', target='codex').returncode, 2)


class RedactTests(unittest.TestCase):
    def test_tokens_keys_and_url_credentials(self):
        text = (
            'sk-ant-abcdefghijklmnopqrstuvwx and AKIAABCDEFGHIJKLMNOP and xoxb-1234567890-abcdef\n'
            'curl https://me:hunter2pass@example.com/x\n'
            '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\n'
            'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123\n'
        )
        out, n = tool.redact(text)
        self.assertEqual(n, 6)
        for leaked in ('sk-ant', 'AKIAABC', 'xoxb-', 'hunter2pass', 'MIIEvQ', 'abcdefghijklmnopqrstuvwxyz0123'):
            self.assertNotIn(leaked, out)
        self.assertIn('https://<REDACTED>@example.com/x', out)

    def test_credentials_in_a_url_of_any_scheme(self):
        for url, leaked in (
            ('postgres://admin:hunter2pass@db.example.com/app', 'hunter2pass'),
            ('redis://:hunter2pass@cache.local:6379', 'hunter2pass'),
            ('mongodb+srv://u:pw12345678@c.mongodb.net/db', 'pw12345678'),
        ):
            out, n = tool.redact('DATABASE at ' + url)
            self.assertEqual(n, 1, url)
            self.assertNotIn(leaked, out)
            self.assertIn('://<REDACTED>@', out)

    def test_long_runs_of_letters_do_not_make_masking_slow(self):
        for text in ('a' * 300_000, 'ab ' * 100_000, 'A_' * 150_000, 'KEY=' + 'a' * 300_000, 'http://' + 'a' * 300_000,
                     ':' * 300_000, 'x+' * 150_000, ('https://' + 'a' * 50 + ' ') * 5_000):
            started = time.time()
            tool.redact(text)
            self.assertLess(time.time() - started, 2.0, text[:20])

    def test_urls_without_a_password_are_left_alone(self):
        text = (
            'git clone ssh://git@github.com:org/repo.git\ngit@github.com:org/repo.git\n'
            'http://localhost:3000/path\nfile:///C:/Users/me/a.txt\nhttps://example.com:8080/a@b\n'
        )
        self.assertEqual(tool.redact(text), (text, 0))

    def test_placeholders_paths_and_prose_are_left_alone(self):
        text = (
            'API_KEY=$API_KEY\nTOKEN=<REDACTED>\nSSH_KEY=/Users/me/.ssh/id_ed25519\n'
            'PASSWORD=xxxxxxxx\nAUTH_TOKEN: 以環境變數提供，不要寫進檔案\nthe token expires soon\n'
        )
        out, n = tool.redact(text)
        self.assertEqual((out, n), (text, 0))

    def test_masking_twice_changes_nothing(self):
        once, _ = tool.redact('GITHUB_TOKEN=abcdef1234567890abcd')
        twice, n = tool.redact(once)
        self.assertEqual((once, n), (twice, 0))


if __name__ == '__main__':
    unittest.main()

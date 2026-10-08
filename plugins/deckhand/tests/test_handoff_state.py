"""Tests for bin/handoff-state.py. Run: python3 -m unittest discover -s tests -p 'test_*.py'

Black-box: each test builds real git repos in a temp folder and runs the CLI
against them, with AGENT_HANDOFF_DIR and the git config isolated from the user's.
"""
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'bin', 'handoff-state.py')
I18N = os.path.join(HERE, '..', 'bin', 'i18n.py')

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
        self.env = dict(os.environ, AGENT_HANDOFF_DIR=self.handoffs, PYTHONDONTWRITEBYTECODE='1', **GIT_ENV)
        self.env.pop('DECKHAND_LANG', None)

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

    def tool(self, *args, cwd=None, stdin=None, env=None, script=SCRIPT):
        return subprocess.run(
            [sys.executable, script] + list(args), cwd=cwd or self.tmp, env=dict(self.env, **(env or {})),
            input=stdin, capture_output=True, text=True, encoding='utf-8',
        )

    def write(self, cwd, narrative='## 目標\n接手測試\n', source='claude', target='codex'):
        done = self.tool('write', '--from', source, '--to', target, '--cwd', cwd, '--no-pr', stdin=narrative)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def check(self, cwd, source='claude', target='codex', fmt='text', lang=None, **kw):
        extra = ['--lang', lang] if lang else []
        return self.tool('check', '--from', source, '--to', target, '--cwd', cwd, '--no-pr', '--format', fmt, *extra, **kw)


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
        self.git(repo, 'remote', 'add', 'origin', 'https://user:tok3nvalue@github.com/o/r.git')  # scan-secrets: allow
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
        self.assertIn('check --from claude --to codex --lang en', result['next_prompt'])

    def test_a_second_handoff_in_the_same_minute_does_not_overwrite(self):
        repo = self.repo()
        first, second = self.write(repo), self.write(repo, narrative='## 目標\n第二份\n')
        self.assertNotEqual(first['path'], second['path'])
        self.assertTrue(second['path'].endswith('-2.md'))
        with open(first['path'], encoding='utf-8') as f:
            self.assertIn('接手測試', f.read())

    def test_secrets_are_masked_and_counted(self):
        repo = self.repo()
        narrative = '## 風險\nGITHUB_TOKEN=abcdef1234567890abcd\ntoken ghp_abcdefghijklmnopqrstuvwxyz123456\n'  # scan-secrets: allow
        result = self.write(repo, narrative)
        self.assertEqual(result['redacted'], 2)
        with open(result['path'], encoding='utf-8') as f:
            text = f.read()
        self.assertNotIn('abcdef1234567890abcd', text)
        self.assertNotIn('ghp_abcdefghij', text)  # scan-secrets: allow
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
        self.assertIn('Conclusion: consistent with the handoff document', done.stdout)

    def test_new_commits_are_counted(self):
        repo = self.repo()
        self.write(repo)
        self.commit(repo, 'second')
        done = self.check(repo)
        self.assertEqual(done.returncode, 1)
        self.assertIn('HEAD moved ahead', done.stdout)
        self.assertIn('(1 new commit(s): second)', done.stdout)

    def test_uncommitted_changes_are_reported_with_paths(self):
        repo = self.repo()
        self.write(repo)
        with open(os.path.join(repo, 'a.txt'), 'a') as f:
            f.write('edit\n')
        done = self.check(repo)
        self.assertEqual(done.returncode, 1)
        self.assertIn('Uncommitted changes differ: tracked 0→1', done.stdout)
        self.assertIn('a.txt', done.stdout)

    def test_a_different_branch_is_reported(self):
        repo = self.repo()
        self.write(repo)
        self.git(repo, 'checkout', '-q', '-b', 'other')
        done = self.check(repo)
        self.assertIn('Different branch: main at handoff, other now', done.stdout)

    def test_amend_reads_as_diverged_history(self):
        repo = self.repo()
        self.write(repo)
        self.git(repo, 'commit', '-q', '--amend', '-m', 'rewritten')
        done = self.check(repo)
        self.assertEqual(done.returncode, 1)
        self.assertIn('HEAD history has diverged', done.stdout)

    def test_going_back_reads_as_behind(self):
        repo = self.repo()
        self.commit(repo, 'second')
        self.write(repo)
        self.git(repo, 'reset', '-q', '--hard', 'HEAD~1')
        self.assertIn('HEAD is behind the handoff point', self.check(repo).stdout)

    def test_same_folder_name_in_another_place_is_an_error(self):
        a = self.repo('repo', parent=os.path.join(self.tmp, 'a'))
        b = self.repo('repo', parent=os.path.join(self.tmp, 'b'))
        self.write(a)
        done = self.check(b)
        self.assertEqual(done.returncode, 1)
        self.assertIn('✗ Different project', done.stdout)

    def test_another_worktree_of_the_same_repo_is_info_not_error(self):
        main = self.repo('main-repo')
        self.write(main)
        wt = os.path.join(self.tmp, 'wt')
        self.git(main, 'worktree', 'add', '-q', wt, '-b', 'feature')
        done = self.check(wt)
        self.assertIn('ℹ Different worktree', done.stdout)
        self.assertIn('Different branch', done.stdout)

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
        self.assertIn('not found in this repo', done.stdout)
        self.assertFalse(os.path.exists(os.path.join(repo, 'touch-pwned')))

    def test_json_prompt_lists_only_the_differences(self):
        repo = self.repo()
        self.write(repo)
        self.commit(repo, 'second')
        out = json.loads(self.check(repo, fmt='json').stdout)
        self.assertEqual(out['differences'], 1)
        self.assertIn('HEAD moved ahead', out['next_prompt'])
        self.assertNotIn('Same project', out['next_prompt'])
        self.assertIn(out['path'], out['next_prompt'])

    def test_reading_direction_uses_the_other_file(self):
        repo = self.repo()
        self.write(repo, source='codex', target='claude')
        self.assertEqual(self.check(repo, source='codex', target='claude').returncode, 0)
        self.assertEqual(self.check(repo, source='claude', target='codex').returncode, 2)


class LanguageTests(Workspace):
    def test_the_report_and_the_prompt_in_zh_tw(self):
        repo = self.repo()
        result = self.tool('write', '--from', 'claude', '--to', 'codex', '--cwd', repo, '--no-pr', '--lang', 'zh-TW', stdin='## 目標\n測試\n')
        written = json.loads(result.stdout)
        self.assertTrue(written['next_prompt'].startswith('請讀取 %s，這是 Claude Code 交給你的交接文件。' % written['path']))
        self.assertIn('check --from claude --to codex --lang zh-TW', written['next_prompt'])
        self.commit(repo, 'second')
        done = self.check(repo, lang='zh-TW')
        self.assertEqual(done.returncode, 1)
        self.assertIn('交接檢查：', done.stdout)
        self.assertIn('HEAD 已前進', done.stdout)
        self.assertIn('多了 1 個 commit：second', done.stdout)
        self.assertIn('結論：1 項差異，先向使用者回報差異，再接手', done.stdout)
        self.assertIn('分鐘前', done.stdout)

    def test_deckhand_lang_is_used_and_the_flag_wins(self):
        repo = self.repo()
        self.write(repo)
        self.assertIn('结论：与交接文档一致', self.check(repo, env={'DECKHAND_LANG': 'zh-CN'}).stdout)
        self.assertIn('結論：引き継ぎドキュメントと一致', self.check(repo, env={'DECKHAND_LANG': 'ja'}).stdout)
        self.assertIn('결론: 인수인계 문서와 일치함', self.check(repo, lang='ko', env={'DECKHAND_LANG': 'ja'}).stdout)
        self.assertIn('Conclusion:', self.tool('--lang', 'en', 'check', '--from', 'claude', '--to', 'codex', '--cwd', repo,
                                               '--no-pr', env={'DECKHAND_LANG': 'ja'}).stdout)

    def test_machine_readable_output_does_not_change_with_the_language(self):
        repo = self.repo()
        self.write(repo)
        self.commit(repo, 'second')
        outs = [json.loads(self.check(repo, fmt='json', lang=lang).stdout) for lang in ('en', 'zh-TW', 'ja')]
        self.assertEqual({tuple(sorted(o)) for o in outs}, {tuple(sorted(outs[0]))})
        self.assertEqual({tuple(i['level'] for i in o['items']) for o in outs}, {tuple(i['level'] for i in outs[0]['items'])})
        self.assertEqual({o['differences'] for o in outs}, {1})
        self.assertEqual(len({o['report'] for o in outs}), 3, 'the report itself is translated')
        other = self.repo('other')
        missing = [self.check(other, fmt='json', lang=lang) for lang in ('en', 'ko')]
        self.assertEqual({m.returncode for m in missing}, {2})
        self.assertEqual({m.stdout for m in missing}, {missing[0].stdout})
        fronts = [self.tool('state', '--no-pr', '--cwd', repo, '--lang', lang).stdout for lang in ('en', 'zh-TW')]
        strip = lambda text: [line for line in text.splitlines() if not line.startswith('created_at:')]  # noqa: E731
        self.assertEqual(strip(fronts[0]), strip(fronts[1]), 'the front matter is the same in every language')

    def test_refusals_follow_the_language(self):
        repo = self.repo()
        done = self.tool('write', '--from', 'claude', '--to', 'codex', '--cwd', repo, '--lang', 'zh-TW', stdin=' \n')
        self.assertEqual(done.returncode, 2)
        self.assertIn('stdin 傳入的內文是空的', done.stderr)
        done = self.tool('write', '--from', 'codex', '--to', 'codex', '--cwd', repo, '--lang', 'ko', stdin='x')
        self.assertEqual(done.returncode, 2)
        self.assertIn('--from과 --to는 서로 달라야 합니다', done.stderr)


class StandaloneCopyTests(Workspace):
    """~/.agent-handoff/bin holds this file alone, without i18n.py: it must still work, in English."""

    def test_the_english_fallback_is_the_catalog(self):
        spec = importlib.util.spec_from_file_location('i18n_for_test', I18N)
        i18n = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(i18n)
        wanted = {k: v for k, v in i18n.EN.items() if k.startswith('handoff.')}
        wanted.update({k: i18n.EN[k] for k in ('common.list_sep', 'common.clause_sep')})
        self.assertEqual(tool.FALLBACK_EN, wanted)

    def test_a_copy_without_i18n_speaks_english_and_still_checks(self):
        alone = os.path.join(self.tmp, 'shared-bin')
        os.makedirs(alone)
        copy = os.path.join(alone, 'handoff-state.py')
        shutil.copy(SCRIPT, copy)
        repo = self.repo()
        written = self.tool('write', '--from', 'claude', '--to', 'codex', '--cwd', repo, '--no-pr', '--lang', 'zh-TW',
                            stdin='## Goal\nx\n', script=copy)
        self.assertEqual(written.returncode, 0, written.stderr)
        self.assertIn('Read ', json.loads(written.stdout)['next_prompt'])
        self.commit(repo, 'second')
        done = self.tool('check', '--from', 'claude', '--to', 'codex', '--cwd', repo, '--no-pr', '--lang', 'zh-TW', script=copy)
        self.assertEqual(done.returncode, 1)
        self.assertIn('HEAD moved ahead', done.stdout)
        self.assertIn('Conclusion: 1 difference(s)', done.stdout)
        self.assertEqual(os.listdir(alone), ['handoff-state.py'], 'nothing is left next to the copy')


class RedactTests(unittest.TestCase):
    def test_tokens_keys_and_url_credentials(self):
        text = (
            'sk-ant-abcdefghijklmnopqrstuvwx and AKIAABCDEFGHIJKLMNOP and xoxb-1234567890-abcdef\n'  # scan-secrets: allow
            'curl https://me:hunter2pass@example.com/x\n'  # scan-secrets: allow
            '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\n'  # scan-secrets: allow
            'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123\n'  # scan-secrets: allow
        )
        out, n = tool.redact(text)
        self.assertEqual(n, 6)
        for leaked in ('sk-ant', 'AKIAABC', 'xoxb-', 'hunter2pass', 'MIIEvQ', 'abcdefghijklmnopqrstuvwxyz0123'):
            self.assertNotIn(leaked, out)
        self.assertIn('https://<REDACTED>@example.com/x', out)

    def test_credentials_in_a_url_of_any_scheme(self):
        for url, leaked in (
            ('postgres://admin:hunter2pass@db.example.com/app', 'hunter2pass'),  # scan-secrets: allow
            ('redis://:hunter2pass@cache.local:6379', 'hunter2pass'),  # scan-secrets: allow
            ('mongodb+srv://u:pw12345678@c.mongodb.net/db', 'pw12345678'),  # scan-secrets: allow
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
            'API_KEY=$API_KEY\nTOKEN=<REDACTED>\nSSH_KEY=/Users/me/.ssh/id_ed25519\n'  # scan-secrets: allow
            'PASSWORD=xxxxxxxx\nAUTH_TOKEN: 以環境變數提供，不要寫進檔案\nthe token expires soon\n'  # scan-secrets: allow
        )
        out, n = tool.redact(text)
        self.assertEqual((out, n), (text, 0))

    def test_masking_twice_changes_nothing(self):
        once, _ = tool.redact('GITHUB_TOKEN=abcdef1234567890abcd')  # scan-secrets: allow
        twice, n = tool.redact(once)
        self.assertEqual((once, n), (twice, 0))


if __name__ == '__main__':
    unittest.main()

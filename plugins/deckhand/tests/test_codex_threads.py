"""Tests for bin/codex-threads.py. Run: python3 -m unittest discover -s tests -p 'test_*.py'

Black-box against a made-up Codex folder: session_index.jsonl and sessions/<y>/<m>/<d>/rollout-*.jsonl.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'bin', 'codex-threads.py')


def line(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n'


def message(role, text):
    return line({'type': 'response_item', 'payload': {'type': 'message', 'role': role, 'content': [{'type': 'text', 'text': text}]}})


class ThreadsCase(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, 'home')
        os.makedirs(self.home)
        self.env = {k: v for k, v in os.environ.items() if k not in ('CODEX_HOME', 'DECKHAND_LANG')}
        self.env.update(HOME=self.home, PYTHONDONTWRITEBYTECODE='1')

    def codex_folder(self, path):
        sessions = os.path.join(path, 'sessions', '2026', '10', '08')
        os.makedirs(sessions)
        with open(os.path.join(path, 'session_index.jsonl'), 'w', encoding='utf-8') as handle:
            handle.write(line({'id': 't1', 'thread_name': '修 README'}))
            handle.write(line({'id': 't2', 'thread_name': 'Guardian review'}))
        threads = {
            't1': {'cwd': '/proj/app', 'messages': [message('user', '請修 README'), message('assistant', '已修好 README 的錯字')]},
            't2': {'cwd': '/proj/app', 'messages': [message('user', 'review'), message('assistant', 'ok')]},
            't3': {'cwd': '/proj/app', 'thread_source': 'subagent', 'messages': [message('assistant', 'sub')]},
            't4': {'cwd': '/elsewhere', 'messages': [message('user', 'other'), message('assistant', 'other answer')]},
        }
        for tid, t in threads.items():
            meta = {'id': tid, 'cwd': t['cwd']}
            if 'thread_source' in t:
                meta['thread_source'] = t['thread_source']
            with open(os.path.join(sessions, 'rollout-%s.jsonl' % tid), 'w', encoding='utf-8') as handle:
                handle.write(line({'type': 'session_meta', 'payload': meta}))
                handle.writelines(t['messages'])
        return path

    def run_tool(self, *args, env=None):
        return subprocess.run([sys.executable, SCRIPT] + list(args), env=dict(self.env, **(env or {})),
                              capture_output=True, text=True, encoding='utf-8', timeout=60)

    def ids(self, done):
        self.assertEqual(done.returncode, 0, done.stderr)
        return sorted(t['id'] for t in json.loads(done.stdout))


class CodexHomeTests(ThreadsCase):
    def test_the_flag_names_the_codex_folder(self):
        folder = self.codex_folder(os.path.join(self.tmp, 'my-codex'))
        done = self.run_tool('--codex-home', folder)
        self.assertEqual(self.ids(done), ['t1', 't4'], 'Guardian reviews and subagents are skipped')
        (t1,) = [t for t in json.loads(done.stdout) if t['id'] == 't1']
        self.assertEqual((t1['name'], t1['lastUser'], t1['lastAssistant']), ('修 README', '請修 README', '已修好 README 的錯字'))
        self.assertEqual(done.stderr, '')

    def test_env_codex_home_then_the_home_folder(self):
        folder = self.codex_folder(os.path.join(self.tmp, 'env-codex'))
        self.assertEqual(self.ids(self.run_tool(env={'CODEX_HOME': folder})), ['t1', 't4'])
        self.assertEqual(self.ids(self.run_tool()), [], 'no ~/.codex yet')
        self.codex_folder(os.path.join(self.home, '.codex'))
        self.assertEqual(self.ids(self.run_tool()), ['t1', 't4'])
        self.assertEqual(self.ids(self.run_tool('--codex-home', os.path.join(self.tmp, 'none'), env={'CODEX_HOME': folder})), [],
                         'the flag wins over the env')

    def test_cwd_filters_by_project(self):
        folder = self.codex_folder(os.path.join(self.tmp, 'c'))
        self.assertEqual(self.ids(self.run_tool('--codex-home', folder, '--cwd', '/proj')), ['t1'])


class LanguageTests(ThreadsCase):
    def test_a_missing_folder_is_an_empty_list_with_a_note_in_the_language_asked_for(self):
        missing = os.path.join(self.tmp, 'nowhere')
        done = self.run_tool('--codex-home', missing)
        self.assertEqual((done.returncode, json.loads(done.stdout)), (0, []))
        self.assertEqual(done.stderr.strip(), 'codex-threads: No Codex folder at %s; there are no threads to list.' % missing)
        done = self.run_tool('--codex-home', missing, '--lang', 'zh-TW')
        self.assertIn('找不到 Codex 資料夾', done.stderr)
        done = self.run_tool('--codex-home', missing, env={'DECKHAND_LANG': 'ja'})
        self.assertIn('Codex フォルダー', done.stderr)

    def test_the_json_does_not_change_with_the_language(self):
        folder = self.codex_folder(os.path.join(self.tmp, 'c'))
        outs = {self.run_tool('--codex-home', folder, '--lang', lang).stdout for lang in ('en', 'zh-TW', 'ko')}
        self.assertEqual(len(outs), 1)


if __name__ == '__main__':
    unittest.main()

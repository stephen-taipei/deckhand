"""Tests for bin/delegate.py. Run: python3 -m unittest discover -s tests -p 'test_*.py'

Black-box with fake codex / agent / agy executables whose calls are logged to a file: nothing here
reaches a real model. HOME is a temp folder, so no installed CLI is found by accident.
"""
import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
MOD = os.path.join(HERE, '..')
SCRIPT = os.path.join(MOD, 'bin', 'delegate.py')

spec = importlib.util.spec_from_file_location('delegate', SCRIPT)
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)

FAKE = r'''#!%(python)s
import json, os, subprocess, sys, time
name = os.path.basename(sys.argv[0])
args = sys.argv[1:]
stdin = '' if sys.stdin.isatty() else sys.stdin.read()
with open(os.environ['FAKE_LOG'], 'a') as log:
    log.write(json.dumps({'tool': name, 'argv': args, 'stdin': stdin, 'cwd': os.getcwd(),
                          'codex_home': os.environ.get('CODEX_HOME')}) + '\n')
mode = os.environ.get('FAKE_MODE', 'ok')

def emit(text):
    if name == 'codex' and '-o' in args:
        with open(args[args.index('-o') + 1], 'w') as handle:
            handle.write(text)
    sys.stdout.write(text)

if mode == 'fail':
    sys.stderr.write('boom: something broke\n')
    sys.exit(7)
if mode == 'empty':
    sys.exit(0)
if mode == 'denied':
    sys.stderr.write('jetski: no output produced - a tool required the "command" permission\n')
    sys.exit(0)
if mode == 'hang':
    child = subprocess.Popen(['sleep', '300'])
    with open(os.environ['FAKE_PIDFILE'], 'w') as handle:
        handle.write(str(child.pid))
    time.sleep(300)
if mode == 'ansi':
    emit('\x1b[31mred\x1b[0m answer')
    sys.exit(0)
if mode == 'big':
    emit('x' * 60000)
    sys.exit(0)
emit('ANSWER from %%s' %% name)
'''

TOKEN = 'ghp_' + 'a1b2c3d4e5f6g7h8i9j0' * 2  # shaped like a GitHub token; the values are made up
BRIEF = '請檢查 README 的錯字，回報結論。'


def mode_of(path):
    return stat.S_IMODE(os.stat(path).st_mode)


class DelegateCase(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = os.path.join(self.tmp, 'bin')
        os.makedirs(self.bin)
        for name in ('codex', 'agent', 'agy'):
            path = os.path.join(self.bin, name)
            with open(path, 'w') as handle:
                handle.write(FAKE % {'python': sys.executable})
            os.chmod(path, 0o755)
        self.log = os.path.join(self.tmp, 'calls.jsonl')
        self.home = os.path.join(self.tmp, 'home')
        os.makedirs(self.home)
        self.runs = os.path.join(self.tmp, 'runs')
        self.work = os.path.join(self.tmp, 'work')
        os.makedirs(self.work)
        self.env = {
            'PATH': os.environ.get('PATH', ''),
            'HOME': self.home,
            'LANG': 'en_US.UTF-8',
            'DELEGATE_CODEX': os.path.join(self.bin, 'codex'),
            'DELEGATE_AGENT': os.path.join(self.bin, 'agent'),
            'DELEGATE_AGY': os.path.join(self.bin, 'agy'),
            'STEPHEN_OPS_DELEGATE_DIR': self.runs,
            'FAKE_LOG': self.log,
            'FAKE_PIDFILE': os.path.join(self.tmp, 'pid'),
        }

    def run_tool(self, *args, brief=BRIEF, mode=None, env=None, cwd=None, script=SCRIPT):
        e = dict(self.env, **(env or {}))
        if mode:
            e['FAKE_MODE'] = mode
        return subprocess.run(
            [sys.executable, script] + list(args), input=brief, env=e, cwd=cwd or self.work,
            capture_output=True, text=True, timeout=60,
        )

    def calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def run_folders(self):
        return sorted(os.listdir(self.runs)) if os.path.isdir(self.runs) else []


class TableTests(DelegateCase):
    def test_the_band_lists_what_the_tool_runs(self):
        with open(os.path.join(MOD, 'hooks', 'delegate.ts'), encoding='utf-8') as handle:
            source = handle.read()
        rows = re.findall(r"\{ key: '(\w+)', tool: '(\w+)', name: '([^']+)', effort: '(\w+)' \}", source)
        self.assertEqual(
            rows,
            [(k, t['tool'], t['name'], t['effort']) for k, t in tool.TARGETS.items()],
            'hooks/delegate.ts and bin/delegate.py name different targets, models or efforts',
        )

    def test_the_five_targets_are_the_ones_asked_for_in_order(self):
        self.assertEqual(list(tool.TARGETS), ['CL', 'CS', 'CA', 'CR', 'GF'])
        t = tool.TARGETS
        self.assertEqual((t['CL']['tool'], t['CL']['model'], t['CL']['effort']), ('codex', 'gpt-6-luna', 'max'))
        self.assertEqual((t['CS']['tool'], t['CS']['model'], t['CS']['effort']), ('codex', 'gpt-6.1-sol', 'medium'))
        self.assertEqual((t['CA']['tool'], t['CA']['model'], t['CA']['effort']), ('codex', 'gpt-6-astra', 'medium'))
        self.assertEqual((t['CR']['tool'], t['CR']['model'], t['CR']['effort']), ('agent', 'grok-4.7-high', 'high'))
        self.assertEqual((t['GF']['tool'], t['GF']['model'], t['GF']['effort']), ('agy', 'gemini-3.8-flash-high', 'high'))


class CommandTests(DelegateCase):
    def build(self, key, prompt='P'):
        return tool.build_command(key, '/b/' + tool.TARGETS[key]['tool'], '/w', '/r/answer.md', 600, prompt)

    def test_codex_runs_read_only_with_the_models_id_and_effort_and_the_brief_on_stdin(self):
        argv, stdin, _ = self.build('CL', 'BRIEF')
        self.assertEqual(argv, [
            '/b/codex', 'exec', '-m', 'gpt-6-luna',
            '-c', 'model_reasoning_effort="max"', '-c', 'approval_policy="never"',
            '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
            '-C', '/w', '-o', '/r/answer.md', '-',
        ])
        self.assertEqual(stdin, 'BRIEF')
        self.assertIn('model_reasoning_effort="medium"', self.build('CS')[0])
        self.assertIn('gpt-6.1-sol', self.build('CS')[0])
        self.assertIn('gpt-6-astra', self.build('CA')[0])

    def test_the_cursor_agent_runs_in_ask_mode(self):
        argv, stdin, _ = self.build('CR', 'BRIEF')
        self.assertEqual(argv, [
            '/b/agent', '-p', '--mode', 'ask', '--model', 'grok-4.7-high', '--output-format', 'text',
            '--trust', '--workspace', '/w',
        ])
        self.assertEqual(stdin, 'BRIEF')

    def test_agy_takes_the_brief_as_p_and_shows_it_elided(self):
        argv, stdin, shown = self.build('GF', 'BRIEF')
        self.assertEqual(argv, [
            '/b/agy', '--model', 'gemini-3.8-flash-high', '--print-timeout=595s', '--disable-slash-commands', '-p=BRIEF',
        ])
        self.assertIsNone(stdin)
        self.assertNotIn('BRIEF', ' '.join(shown))
        self.assertTrue(shown[-1].startswith('-p=<說明'))

    def test_no_target_can_write_or_skip_a_permission_check(self):
        forbidden = ('--force', '--yolo', '-f', '--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox',
                     'workspace-write', 'danger-full-access', '--approve-for-me', '--auto-review', 'accept-edits')
        for key in tool.TARGETS:
            argv = self.build(key)[0]
            for word in forbidden:
                self.assertNotIn(word, argv, '%s: %s' % (key, word))
            self.assertFalse([a for a in argv if a.startswith('--dangerously')], key)


class RunTests(DelegateCase):
    def test_a_codex_target_answers_and_leaves_a_private_record(self):
        done = self.run_tool('run', '--to', 'cl')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('ANSWER from codex', done.stdout)
        for part in ('CL · Codex · GPT-6 Luna (gpt-6-luna) · effort max', '唯讀', '有回答', '說明檔：', '回答檔：'):
            self.assertIn(part, done.stdout)
        (call,) = self.calls()
        self.assertEqual(call['tool'], 'codex')
        self.assertEqual(call['cwd'], os.path.realpath(self.work))
        self.assertEqual(call['argv'][call['argv'].index('-C') + 1], os.path.realpath(self.work))
        self.assertEqual(call['codex_home'], os.path.join(self.home, '.codex'))
        self.assertTrue(call['stdin'].startswith(tool.PREAMBLE), 'the standard rules come first')
        self.assertTrue(call['stdin'].rstrip().endswith(BRIEF))
        (folder,) = self.run_folders()
        run = os.path.join(self.runs, folder)
        self.assertRegex(folder, tool.RUN_NAME)
        self.assertEqual(mode_of(self.runs), 0o700)
        self.assertEqual(mode_of(run), 0o700)
        for name in ('prompt.md', 'answer.md', 'stderr.log'):
            self.assertEqual(mode_of(os.path.join(run, name)), 0o600, name)
        with open(os.path.join(run, 'prompt.md'), encoding='utf-8') as handle:
            self.assertEqual(handle.read(), call['stdin'], 'the record is what was sent')
        with open(os.path.join(run, 'answer.md'), encoding='utf-8') as handle:
            self.assertEqual(handle.read().strip(), 'ANSWER from codex')

    def test_every_target_calls_its_own_cli(self):
        for key, t in tool.TARGETS.items():
            with self.subTest(key=key):
                before = len(self.calls())
                done = self.run_tool('run', '--to', key)
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertIn('ANSWER from ' + t['tool'], done.stdout)
                call = self.calls()[before]
                self.assertEqual(call['tool'], t['tool'])
                self.assertIn(t['model'], call['argv'])
                brief_sent = call['stdin'] or ' '.join(call['argv'])
                self.assertIn(BRIEF, brief_sent)

    def test_the_working_directory_reaches_the_cli(self):
        sub = os.path.join(self.tmp, 'proj dir')
        os.makedirs(sub)
        self.assertEqual(self.run_tool('run', '--to', 'CR', '--cwd', sub).returncode, 0)
        (call,) = self.calls()
        self.assertEqual(call['cwd'], os.path.realpath(sub))
        self.assertEqual(call['argv'][call['argv'].index('--workspace') + 1], os.path.realpath(sub))

    def test_a_brief_can_come_from_a_file(self):
        path = os.path.join(self.tmp, 'brief.md')
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write('來自檔案的說明')
        done = self.run_tool('run', '--to', 'CA', '--prompt-file', path, brief='')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('來自檔案的說明', self.calls()[0]['stdin'])

    def test_dry_run_checks_and_shows_but_runs_nothing(self):
        done = self.run_tool('run', '--to', 'GF', '--dry-run')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('dry-run', done.stdout)
        self.assertIn('--model gemini-3.8-flash-high', done.stdout)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.run_folders(), [])
        self.assertEqual(self.run_tool('run', '--to', 'GF', '--dry-run', brief='x ' + TOKEN).returncode, 2)

    def test_ansi_colors_are_stripped_from_the_answer(self):
        done = self.run_tool('run', '--to', 'CR', mode='ansi')
        self.assertIn('red answer', done.stdout)
        self.assertNotIn('\x1b', done.stdout)

    def test_a_long_answer_is_cut_on_screen_and_kept_whole_on_disk(self):
        done = self.run_tool('run', '--to', 'CR', mode='big')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('已截斷', done.stdout)
        self.assertLess(len(done.stdout), tool.SHOWN_ANSWER_CHARS + 2000)
        (folder,) = self.run_folders()
        with open(os.path.join(self.runs, folder, 'answer.md'), encoding='utf-8') as handle:
            self.assertEqual(len(handle.read().strip()), 60000)


class RefusalTests(DelegateCase):
    def test_a_secret_is_refused_by_line_and_never_echoed_or_sent(self):
        brief = '第一行沒事\ntoken: %s\n第三行沒事' % TOKEN
        done = self.run_tool('run', '--to', 'CL', brief=brief)
        self.assertEqual(done.returncode, 2)
        self.assertIn('第 2 行', done.stderr)
        self.assertNotIn(TOKEN, done.stdout + done.stderr)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.run_folders(), [])

    def test_the_secret_patterns_are_the_shared_ones(self):
        for line in ('AWS_SECRET_ACCESS_KEY=abcd1234efgh5678', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234',
                     'postgres://admin:hunter2pass@db.example.com/x', '-----BEGIN RSA PRIVATE KEY-----'):
            with self.subTest(line=line):
                self.assertEqual(tool.find_secrets('ok\n' + line + '\n'), [2])
        self.assertEqual(tool.find_secrets('API_KEY=<your key>\nGITHUB_TOKEN=$GITHUB_TOKEN\n普通的一行'), [])
        multi = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
        self.assertIn(1, tool.find_secrets(multi))

    def test_nothing_is_sent_when_the_secret_check_cannot_load(self):
        lonely = os.path.join(self.tmp, 'lonely')
        os.makedirs(lonely)
        copy = os.path.join(lonely, 'delegate.py')
        shutil.copy(SCRIPT, copy)
        done = self.run_tool('run', '--to', 'CL', script=copy)
        self.assertEqual(done.returncode, 2)
        self.assertIn('無法載入機密檢查', done.stderr)
        self.assertEqual(self.calls(), [])

    def test_empty_brief_unknown_target_and_bad_cwd(self):
        self.assertEqual(self.run_tool('run', '--to', 'CL', brief='  \n ').returncode, 2)
        done = self.run_tool('run', '--to', 'ZZ')
        self.assertEqual(done.returncode, 2)
        self.assertIn('CL CS CA CR GF', done.stderr)
        self.assertEqual(self.run_tool('run', '--to', 'CL', '--cwd', os.path.join(self.tmp, 'nope')).returncode, 2)
        self.assertEqual(self.calls(), [])

    def test_an_oversized_brief_is_refused_and_agy_has_the_lower_limit(self):
        over_agy = 'a' * (tool.MAX_ARGV_BRIEF_BYTES + 1)
        self.assertEqual(self.run_tool('run', '--to', 'GF', brief=over_agy).returncode, 2)
        self.assertEqual(self.run_tool('run', '--to', 'CR', brief=over_agy).returncode, 0)
        self.assertEqual(self.run_tool('run', '--to', 'CR', brief='a' * (tool.MAX_BRIEF_BYTES + 1)).returncode, 2)

    def test_a_missing_cli_is_exit_3_and_nothing_runs(self):
        done = self.run_tool('run', '--to', 'CL', env={'DELEGATE_CODEX': os.path.join(self.tmp, 'gone')})
        self.assertEqual(done.returncode, 3)
        self.assertIn('找不到 Codex 的 CLI', done.stderr)
        self.assertEqual(self.calls(), [])


class FailureTests(DelegateCase):
    def test_a_failing_cli_is_exit_5_with_its_stderr(self):
        done = self.run_tool('run', '--to', 'CS', mode='fail')
        self.assertEqual(done.returncode, 5)
        self.assertIn('失敗（exit 7）', done.stdout)
        self.assertIn('stderr：boom: something broke', done.stdout)

    def test_no_answer_is_exit_5(self):
        done = self.run_tool('run', '--to', 'CR', mode='empty')
        self.assertEqual(done.returncode, 5)
        self.assertIn('沒有回答', done.stdout)

    def test_a_tool_denied_in_headless_mode_shows_why(self):
        done = self.run_tool('run', '--to', 'GF', mode='denied')
        self.assertEqual(done.returncode, 5)
        self.assertIn('permission', done.stdout)

    def test_a_timeout_is_exit_4_and_takes_the_children_down(self):
        done = self.run_tool('run', '--to', 'CR', '--timeout', '0.02', mode='hang')
        self.assertEqual(done.returncode, 4, done.stdout + done.stderr)
        self.assertIn('逾時', done.stdout)
        with open(self.env['FAKE_PIDFILE']) as handle:
            pid = int(handle.read())
        for _ in range(30):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            os.kill(pid, 9)
            self.fail('the CLI\'s child process was left running')


class KeepingTests(DelegateCase):
    def test_old_run_folders_go_and_nothing_else_does(self):
        os.makedirs(self.runs)
        old, fresh, odd = '20200101-000000-CL-aaaa', '20260101-000000-CS-bbbb', 'notes'
        outside = os.path.join(self.tmp, 'outside')
        os.makedirs(outside)
        for name in (old, fresh, odd, 'x'):
            os.makedirs(os.path.join(self.runs, name))
        os.symlink(outside, os.path.join(self.runs, '20200101-000000-CA-cccc'))
        with open(os.path.join(self.runs, '20200101-000000-CR-dddd'), 'w') as handle:
            handle.write('a file wearing a run name')
        long_ago = time.time() - 10 * 86400
        for name in (old, odd, 'x', '20200101-000000-CR-dddd'):
            os.utime(os.path.join(self.runs, name), (long_ago, long_ago))
        removed = tool.prune(self.runs)
        self.assertEqual(removed, [old])
        self.assertEqual(sorted(os.listdir(self.runs)), sorted([fresh, odd, 'x', '20200101-000000-CA-cccc', '20200101-000000-CR-dddd']))
        self.assertTrue(os.path.isdir(outside), 'a symlink is never followed')

    def test_a_folder_that_is_not_a_real_directory_of_the_user_is_not_used(self):
        target = os.path.join(self.tmp, 'elsewhere')
        os.makedirs(target)
        link = os.path.join(self.tmp, 'linked')
        os.symlink(target, link)
        with self.assertRaises(SystemExit) as caught, contextlib.redirect_stderr(io.StringIO()):
            tool._own_private_dir(link)
        self.assertEqual(caught.exception.code, 2)

    def test_a_real_run_prunes_old_folders_first(self):
        os.makedirs(self.runs)
        old = os.path.join(self.runs, '20200101-000000-CL-aaaa')
        os.makedirs(old)
        long_ago = time.time() - 10 * 86400
        os.utime(old, (long_ago, long_ago))
        self.assertEqual(self.run_tool('run', '--to', 'CR').returncode, 0)
        self.assertFalse(os.path.exists(old))
        self.assertEqual(len(self.run_folders()), 1)


class FindingTests(DelegateCase):
    def test_the_search_order(self):
        env = {'PATH': os.path.join(self.tmp, 'empty-path')}
        with mock.patch.dict(os.environ, {'HOME': self.home}):
            self.assertIsNone(tool.find_bin('codex', env))
            for version in ('v20.1.0', 'v24.12.0', 'v9.9.9'):
                path = os.path.join(self.home, '.nvm', 'versions', 'node', version, 'bin', 'codex')
                os.makedirs(os.path.dirname(path))
                with open(path, 'w') as handle:
                    handle.write('#!/bin/sh\n')
                os.chmod(path, 0o755)
            self.assertIn('v24.12.0', tool.find_bin('codex', env), 'the newest node version wins, by number')
            on_path = dict(env, PATH=self.bin)
            self.assertEqual(tool.find_bin('codex', on_path), os.path.join(self.bin, 'codex'), 'PATH comes before the defaults')
            self.assertEqual(tool.find_bin('codex', dict(on_path, DELEGATE_CODEX=os.path.join(self.bin, 'agy'))), os.path.join(self.bin, 'agy'))
            self.assertIsNone(tool.find_bin('codex', dict(on_path, DELEGATE_CODEX=os.path.join(self.tmp, 'gone'))), 'an override that is not there is not replaced')
            local = os.path.join(self.home, '.local', 'bin', 'cursor-agent')
            os.makedirs(os.path.dirname(local))
            with open(local, 'w') as handle:
                handle.write('#!/bin/sh\n')
            os.chmod(local, 0o755)
            self.assertEqual(tool.find_bin('agent', env), local)

    def test_targets_lists_where_each_cli_is(self):
        done = self.run_tool('targets', '--format', 'json', brief='')
        self.assertEqual(done.returncode, 0, done.stderr)
        rows = json.loads(done.stdout)
        self.assertEqual([r['key'] for r in rows], ['CL', 'CS', 'CA', 'CR', 'GF'])
        self.assertEqual(rows[0]['bin'], os.path.join(self.bin, 'codex'))
        self.assertEqual(rows[3]['bin'], os.path.join(self.bin, 'agent'))
        text = self.run_tool('targets', brief='').stdout
        self.assertIn('GPT-6 Luna', text)


if __name__ == '__main__':
    unittest.main()

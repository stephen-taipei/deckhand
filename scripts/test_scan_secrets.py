"""Tests for scan-secrets.py.

Every fake secret here is assembled at run time, so this file itself stays clean
when the scanner checks the repository.
"""

import contextlib
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'scan-secrets.py')

_spec = importlib.util.spec_from_file_location('scan_secrets', SCRIPT)
scan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scan)

AT = '@'
BODY = 'A1b2C3d4E5f6G7h8J9k0'           # 20 mixed characters
LONG = BODY + 'MnPqRsTuVw'               # 30
GH36 = BODY + 'XyZ123wq4R5t6Y'            # 34 ... padded below
GH36 = (GH36 + 'Zz')[:36]
BEGIN = '-----' + 'BEGIN '
FAKE = {
    'private-key': BEGIN + 'RSA PRIVATE KEY-----',
    'openssh-key': BEGIN + 'OPENSSH PRIVATE KEY-----',
    'sk': 's' + 'k-ant-api03-' + LONG,
    'sk-proj': 's' + 'k-proj-' + LONG,
    'ghp': 'gh' + 'p_' + GH36,
    'gho': 'gh' + 'o_' + GH36,
    'ghs': 'gh' + 's_' + GH36,
    'pat': 'github' + '_pat_' + LONG + '_' + BODY,
    'aws': 'AK' + 'IA' + 'Q7R2T9W4Y6U1I3O5',
    'slack': 'xo' + 'xb-' + '1234567890-' + BODY,
    'google': 'AI' + 'za' + 'Sy' + BODY + 'Q1w2E3r4T5y6U',
    'jwt': 'ey' + 'JhbGciOiJIUzI1NiJ9' + '.' + 'ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
}


def hits(text, path='notes.md', deny=()):
    return [f.rule for f in scan.scan_text(path, text, deny)]


class TokenRules(unittest.TestCase):
    def test_each_provider_token_is_found(self):
        expected = {
            'private-key': 'private-key', 'openssh-key': 'private-key', 'sk': 'sk-token',
            'sk-proj': 'sk-token', 'ghp': 'github-token', 'gho': 'github-token',
            'ghs': 'github-token', 'pat': 'github-pat', 'aws': 'aws-access-key',
            'slack': 'slack-token', 'google': 'google-api-key', 'jwt': 'jwt',
        }
        for key, rule in expected.items():
            with self.subTest(key=key):
                self.assertEqual(hits('value: ' + FAKE[key] + ' end'), [rule])

    def test_bearer_token(self):
        self.assertEqual(hits('Authorization: Bearer ' + LONG), ['bearer-token'])

    def test_bearer_placeholders_pass(self):
        for value in ('${TOKEN}', '<token>', '$GITHUB_TOKEN', 'xxxxxxxxxxxxxxxxxxxxxxxx'):
            with self.subTest(value=value):
                self.assertEqual(hits('Authorization: Bearer ' + value), [])

    def test_placeholder_tokens_pass(self):
        lines = [
            'gh' + 'p_' + 'x' * 36,
            's' + 'k-ant-' + 'x' * 30,
            's' + 'k-learn-is-a-python-package-name',
            'AK' + 'IA' + 'IOSFODNN7' + 'EXAMPLE',
        ]
        for line in lines:
            with self.subTest(line=line):
                self.assertEqual(hits(line), [])

    def test_sk_inside_a_word_is_not_a_token(self):
        self.assertEqual(hits('task-' + LONG), [])


class AssignmentRule(unittest.TestCase):
    def test_quoted_literal_in_code(self):
        self.assertEqual(hits('api_key = "' + BODY + '"', 'app.py'), ['secret-assignment'])

    def test_env_style_inside_a_code_string(self):
        self.assertEqual(hits("line = 'DB_PASSWORD=" + BODY + "'", 'app.py'), ['secret-assignment'])

    def test_unquoted_value_in_config(self):
        self.assertEqual(hits('password: ' + BODY, 'config.yml'), ['secret-assignment'])
        self.assertEqual(hits('export AUTH_TOKEN=' + BODY, 'setup.sh'), ['secret-assignment'])

    def test_variables_and_calls_in_code_pass(self):
        for line in ('token = get_token_v2()', 'password = args.password2', 'api_key = config.api_key_v1',
                     'const tokenPattern2 = makePattern(x)'):
            with self.subTest(line=line):
                self.assertEqual(hits(line, 'app.ts'), [])

    def test_placeholders_pass(self):
        for line in ('API_KEY=<your key>', 'GITHUB_TOKEN=$GITHUB_TOKEN', 'token: ${{ secrets.GH_TOKEN }}',
                     'password = "changeme123"', 'SECRET_KEY=your-secret-key-here', 'api_key: "xxxxxxxxxxxx"',
                     'TOKEN=null', 'password = "short1"'):
            with self.subTest(line=line):
                self.assertEqual(hits(line, 'config.env'), [])


class UrlCredentials(unittest.TestCase):
    def test_any_scheme(self):
        for url in ('https://alice:' + BODY + AT + 'github.com/o/r.git',
                    'postgres://admin:' + BODY + AT + 'db.internal:5432/app',
                    'redis://:' + BODY + AT + 'cache.local:6379',
                    'mongodb+srv://u:' + BODY + AT + 'cluster0.mongodb.net/db'):
            with self.subTest(url=url):
                self.assertEqual(hits('url ' + url), ['url-credentials'])

    def test_placeholder_passwords_pass(self):
        for url in ('https://user:password' + AT + 'host.com/x', 'https://x-access-token:${TOKEN}' + AT + 'github.com/o/r',
                    'postgres://me:****' + AT + 'db.host.com/app', 'http://localhost:3000/path',
                    'https://example.com:8080/a' + AT + 'b'):
            with self.subTest(url=url):
                self.assertEqual(hits(url), [])


class Emails(unittest.TestCase):
    def test_personal_address(self):
        self.assertEqual(hits('contact alice.smith' + AT + 'mail.co.uk today'), ['email'])

    def test_allowlisted_addresses(self):
        for address in ('12345+alice' + AT + 'users.noreply.github.com', 't' + AT + 'example.com',
                        'a' + AT + 'mail.example.org', 'b' + AT + 'example.net', 'c' + AT + 'host.test',
                        'noreply' + AT + 'anthropic.com', 'git' + AT + 'github.com', 'icon' + AT + '2x.png'):
            with self.subTest(address=address):
                self.assertEqual(hits('x ' + address + ' y'), [])

    def test_escaped_newline_before_git_remote(self):
        self.assertEqual(hits("text = 'a\\ngit" + AT + "github.com:org/repo.git'", 'test.py'), [])

    def test_package_and_action_versions_are_not_addresses(self):
        self.assertEqual(hits('uses: actions/checkout' + AT + 'v4 and deckhand' + AT + 'deckhand and pkg' + AT + '1.2.3'), [])


class HomePaths(unittest.TestCase):
    def test_real_names_are_found(self):
        for path in ('/Users/' + 'alice/project', '/home/' + 'bob.lee/.config',
                     'C:\\Users\\' + 'carol\\AppData', 'file:///Users/' + 'dave/x'):
            with self.subTest(path=path):
                self.assertEqual(hits('see ' + path), ['home-path'])

    def test_placeholders_and_urls_pass(self):
        for path in ('/Users/me/project', '/home/runner/work', '/home/user/x', '/Users/you/x',
                     'https://site.com/home/' + 'about/', '~/projects/x', '/Users/<name>/'):
            with self.subTest(path=path):
                self.assertEqual(hits('see ' + path), [])


class DenyTermsAndMarker(unittest.TestCase):
    def test_deny_term_is_found_case_insensitively_on_word_edges(self):
        deny = scan.deny_patterns(['zelda.k'])
        self.assertEqual(hits('owner: Zelda.K here', deny=deny), ['deny-term'])
        self.assertEqual(hits('owner: zelda.kx here', deny=deny), [])

    def test_allow_marker_skips_rules_but_not_deny_terms(self):
        line = 'key = "' + BODY + '"  # scan-secrets: allow'
        self.assertEqual(hits(line, 'app.py'), [])
        deny = scan.deny_patterns(['zelda'])
        self.assertEqual(hits('zelda ' + line, 'app.py', deny), ['deny-term'])

    def test_short_and_generic_terms_are_ignored(self):
        self.assertFalse(scan.usable_deny_term('me'))
        self.assertFalse(scan.usable_deny_term('runner'))
        self.assertFalse(scan.usable_deny_term('ROOT'))
        self.assertTrue(scan.usable_deny_term('zelda'))

    def test_runtime_terms_come_from_the_os_and_git(self):
        email = 'zelda.k' + AT + 'mail.com'
        with mock.patch.object(scan.getpass, 'getuser', return_value='zeldak'), \
                mock.patch.dict(os.environ, {'USER': 'zeldak', 'LOGNAME': '', 'USERNAME': ''}), \
                mock.patch.object(scan, '_git', return_value=email + '\n'):
            terms = scan.runtime_deny_terms()
        self.assertEqual(terms, ['zeldak', email, 'zelda.k'])

    def test_runtime_terms_skip_ci_accounts_and_noreply(self):
        email = '1+bot' + AT + 'users.noreply.github.com'
        with mock.patch.object(scan.getpass, 'getuser', return_value='runner'), \
                mock.patch.dict(os.environ, {'USER': 'runner', 'LOGNAME': '', 'USERNAME': ''}), \
                mock.patch.object(scan, '_git', return_value=email):
            self.assertEqual(scan.runtime_deny_terms(), [])

    def test_deny_file_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'deny.txt')
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write('# comment\n\nZelda Kim\nab\nproject-falcon\n')
            self.assertEqual(scan.read_deny_file(path), ['Zelda Kim', 'project-falcon'])


class Masking(unittest.TestCase):
    def test_mask_keeps_a_short_prefix_and_the_length(self):
        self.assertEqual(scan.mask('abcdefghijklmnopqrst'), 'abcd…[20 chars]')
        self.assertEqual(scan.mask('abcdefghij'), 'ab…[10 chars]')
        self.assertEqual(scan.mask('abc'), 'a…[3 chars]')

    def test_preview_never_holds_the_secret(self):
        for key, secret in FAKE.items():
            with self.subTest(key=key):
                findings = scan.scan_text('f.md', 'token is ' + secret + ' ok')
                self.assertTrue(findings)
                for finding in findings:
                    self.assertNotIn(secret, finding.format())
                    self.assertNotIn(secret[6:], finding.format())

    def test_every_secret_on_a_line_is_masked_in_each_preview(self):
        line = FAKE['ghp'] + ' and ' + FAKE['aws']
        findings = scan.scan_text('f.md', line)
        self.assertEqual([f.rule for f in findings], ['github-token', 'aws-access-key'])
        for finding in findings:
            self.assertNotIn(FAKE['ghp'], finding.preview)
            self.assertNotIn(FAKE['aws'], finding.preview)

    def test_preview_of_a_deny_term_is_masked(self):
        finding = scan.scan_text('f.md', 'by Zelda Kim, 2026', scan.deny_patterns(['Zelda Kim']))[0]
        self.assertNotIn('Zelda Kim', finding.format())
        self.assertIn('Ze…[9 chars]', finding.format())

    def test_long_lines_are_cut_around_the_finding(self):
        line = 'a ' * 200 + FAKE['aws'] + ' b' * 200
        preview = scan.scan_text('f.md', line)[0].preview
        self.assertLess(len(preview), 120)
        self.assertTrue(preview.startswith('…') and preview.endswith('…'))


class Backtracking(unittest.TestCase):
    """Adversarial lines must be scanned in linear time."""

    def test_adversarial_lines_finish_quickly(self):
        size = 60000
        lines = [
            'a' * size,
            'a.' * (size // 2),
            ('a' * 63 + '.') * (size // 64),
            'token_' * (size // 6),
            'x://' + 'a:' * (size // 2),
            'a://' * (size // 4),
            ('a' * 60 + AT) * (size // 61),
            '/Users/' * (size // 7),
            'eyJ' + 'a' * size,
            'Bearer ' + 'a' * size,
            '-' * size,
            'sk-' + '-' * size,
            'password=' * (size // 9),
            'C:\\Users\\' * (size // 9),
        ]
        deny = scan.deny_patterns(['zelda'])
        for line in lines:
            started = time.time()
            scan.scan_line('f.md', 1, line, deny)
            elapsed = time.time() - started
            with self.subTest(line=line[:20]):
                self.assertLess(elapsed, 2.0)


class CommandLine(unittest.TestCase):
    def run_script(self, args, cwd):
        return subprocess.run([sys.executable, SCRIPT] + args, cwd=cwd, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True, check=False)

    def git(self, cwd, *args):
        subprocess.run(['git'] + list(args), cwd=cwd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def write(self, path, text):
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(text)

    def test_exit_codes_and_masked_output_for_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            clean = os.path.join(tmp, 'clean.md')
            dirty = os.path.join(tmp, 'dirty.md')
            self.write(clean, 'nothing to see\n')
            self.write(dirty, 'first line\nkey ' + FAKE['ghp'] + '\n')
            ok = self.run_script(['--no-runtime-deny', clean], tmp)
            self.assertEqual(ok.returncode, 0, ok.stderr)
            bad = self.run_script(['--no-runtime-deny', tmp], tmp)
            self.assertEqual(bad.returncode, 1)
            self.assertIn('dirty.md:2: github-token:', bad.stdout)
            self.assertNotIn(FAKE['ghp'], bad.stdout + bad.stderr)

    def test_binary_files_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, 'blob.bin'), 'wb') as fh:
                fh.write(b'\0\1\2' + FAKE['ghp'].encode())
            result = self.run_script(['--no-runtime-deny', tmp], tmp)
            self.assertEqual(result.returncode, 0, result.stdout)

    def test_git_mode_scans_tracked_files_only_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.git(tmp, 'init', '-q')
            self.write(os.path.join(tmp, 'tracked.md'), 'ok\n')
            self.git(tmp, 'add', 'tracked.md')
            self.write(os.path.join(tmp, 'loose.md'), FAKE['aws'] + '\n')
            self.assertEqual(self.run_script(['--no-runtime-deny'], tmp).returncode, 0)
            result = self.run_script(['--no-runtime-deny', '--include-untracked'], tmp)
            self.assertEqual(result.returncode, 1)
            self.assertIn('loose.md:1: aws-access-key:', result.stdout)

    def test_deny_file_must_be_untracked(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.git(tmp, 'init', '-q')
            self.write(os.path.join(tmp, 'notes.md'), 'written by Zelda Kim\n')
            self.write(os.path.join(tmp, 'deny.txt'), 'Zelda Kim\n')
            self.git(tmp, 'add', 'notes.md')
            result = self.run_script(['--no-runtime-deny', '--deny-file', 'deny.txt', '--include-untracked'], tmp)
            self.assertEqual(result.returncode, 1)
            self.assertIn('notes.md:1: deny-term:', result.stdout)
            self.assertNotIn('deny.txt', result.stdout)
            self.assertNotIn('Zelda Kim', result.stdout + result.stderr)
            self.git(tmp, 'add', 'deny.txt')
            refused = self.run_script(['--no-runtime-deny', '--deny-file', 'deny.txt'], tmp)
            self.assertEqual(refused.returncode, 2)

    def test_outside_git_without_paths_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, GIT_CEILING_DIRECTORIES=os.path.dirname(tmp))
            result = subprocess.run([sys.executable, SCRIPT, '--no-runtime-deny'], cwd=tmp, env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
            self.assertEqual(result.returncode, 2)

    def test_main_in_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'a.md')
            self.write(path, 'Authorization: Bearer ' + LONG + '\n')
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = scan.main(['--no-runtime-deny', path])
            self.assertEqual(code, 1)
            self.assertIn('bearer-token', out.getvalue())
            self.assertNotIn(LONG, out.getvalue())


if __name__ == '__main__':
    unittest.main()

"""Tests for check-attribution.py, on fixture repositories in temporary folders."""

import contextlib
import importlib.util
import io
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'check-attribution.py')

_spec = importlib.util.spec_from_file_location('check_attribution', SCRIPT)
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)

PERSON = ('Stephen', '6315361+stephen-taipei@users.noreply.github.com')
CLAUDE = ('Claude', 'noreply@anthropic.com')


class Repo(object):
    """An empty git repository with one commit per `commit` call."""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix='check-attribution-')
        self.git('init', '-q')
        self.count = 0

    def git(self, *args, env=None):
        full = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull, **(env or {}))
        return subprocess.run(['git'] + list(args), cwd=self.root, env=full, check=True, capture_output=True, text=True).stdout

    def commit(self, message, author=PERSON, committer=PERSON):
        self.count += 1
        with open(os.path.join(self.root, 'f.txt'), 'w') as f:
            f.write(str(self.count))
        self.git('add', 'f.txt')
        env = {
            'GIT_AUTHOR_NAME': author[0], 'GIT_AUTHOR_EMAIL': author[1],
            'GIT_COMMITTER_NAME': committer[0], 'GIT_COMMITTER_EMAIL': committer[1],
        }
        self.git('commit', '-q', '-m', message, env=env)
        return self.git('rev-parse', 'HEAD').strip()

    def close(self):
        shutil.rmtree(self.root, ignore_errors=True)


class CheckAttributionTest(unittest.TestCase):
    def setUp(self):
        self.repo = Repo()
        self.addCleanup(self.repo.close)

    def run_main(self, *args):
        out, err = io.StringIO(), io.StringIO()
        os.environ['CHECK_ATTRIBUTION_ROOT'] = self.repo.root
        self.addCleanup(os.environ.pop, 'CHECK_ATTRIBUTION_ROOT', None)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = check.main(list(args))
        return code, out.getvalue(), err.getvalue()

    def test_clean_history_passes(self):
        self.repo.commit('Add a feature\n\nWhy it is needed.')
        self.repo.commit('Fix it\n\nCo-Authored-By: Ada Lovelace <ada@example.com>')
        self.assertEqual(self.run_main()[0], 0)

    def test_a_commit_authored_by_claude_is_refused(self):
        sha = self.repo.commit('Add the policy', author=CLAUDE, committer=CLAUDE)
        code, out, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn('%s: author is noreply@anthropic.com' % sha[:7], out)
        self.assertIn('%s: committer is noreply@anthropic.com' % sha[:7], out)

    def test_claude_trailers_and_footer_are_refused(self):
        self.repo.commit('Scope the tests\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>')
        self.repo.commit('Bind the tests\n\nClaude-Session: https://claude.ai/code/session_x')
        self.repo.commit('Docs\n\n\U0001F916 Generated with [Claude Code](https://claude.com/claude-code)')
        self.repo.commit('More\n\nco-authored-by: Claude <someone@example.com>')
        code, out, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(out.count('co-author trailer'), 2)
        self.assertEqual(out.count('session trailer'), 1)
        self.assertEqual(out.count('generated-with line'), 1)

    def test_a_range_checks_only_its_commits(self):
        old = self.repo.commit('Old', author=CLAUDE)
        self.repo.commit('New')
        self.assertEqual(self.run_main('%s..HEAD' % old)[0], 0)
        self.assertEqual(self.run_main()[0], 1)

    def test_a_bad_revision_is_a_git_failure(self):
        self.repo.commit('One')
        code, _, err = self.run_main('no-such-ref..HEAD')
        self.assertEqual(code, 2)
        self.assertIn('git log', err)

    def test_a_word_that_only_contains_claude_is_not_a_co_author(self):
        self.repo.commit('Fix\n\nCo-Authored-By: Claudette Smith <c@example.com>')
        self.assertEqual(self.run_main()[0], 0)


if __name__ == '__main__':
    unittest.main()

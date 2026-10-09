"""Tests for check-version.py, on fixture repositories in temporary folders."""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'check-version.py')

_spec = importlib.util.spec_from_file_location('check_version', SCRIPT)
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)

BADGE = '[![Version](https://img.shields.io/badge/version-%s-2563EB?style=flat-square)](plugins/deckhand/.claude-plugin/plugin.json)'


class Fixture(object):
    """A minimal repository that states one version in all eight places."""

    def __init__(self, version='1.0.0'):
        self.root = tempfile.mkdtemp(prefix='check-version-')
        self.write_json(check.PLUGIN_JSON, {'name': 'deckhand', 'version': version})
        self.write_json(check.MARKETPLACE_JSON, {'name': 'deckhand', 'plugins': [
            {'name': 'deckhand', 'version': version, 'source': './plugins/deckhand'}]})
        for name in check.READMES:
            self.readme(name, version)
        self.changelog('# Changelog\n\n## %s — 2026-10-08\n\n### Added\n\n## 0.9.0 — 2026-09-01\n' % version)

    def write(self, rel, text):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(text)

    def write_json(self, rel, data):
        self.write(rel, json.dumps(data, indent=2) + '\n')

    def readme(self, name, version):
        lines = ['<h1>Deckhand</h1>'] + [''] * 7 + [BADGE % version, '', 'Text.']
        self.write(name, '\n'.join(lines) + '\n')

    def changelog(self, text):
        self.write(check.CHANGELOG, text)

    def run(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = check.main(['--root', self.root] + list(args))
        return code, out.getvalue().splitlines(), err.getvalue()

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


class CheckVersion(unittest.TestCase):
    def setUp(self):
        self.repo = Fixture('1.0.0')
        self.addCleanup(self.repo.cleanup)

    def test_all_consistent(self):
        code, lines, err = self.repo.run()
        self.assertEqual(code, 0)
        self.assertEqual(lines, [])
        self.assertIn('1.0.0 in all 8 place(s)', err)

    def test_one_readme_off(self):
        self.repo.readme('README.ja.md', '1.0.1')
        code, lines, _ = self.repo.run()
        self.assertEqual(code, 1)
        self.assertEqual(lines, ['README.ja.md:9: version 1.0.1, but %s says 1.0.0' % check.PLUGIN_JSON])

    def test_changelog_off(self):
        self.repo.changelog('# Changelog\n\n## Unreleased\n\n## 0.9.0 — 2026-09-01\n')
        code, lines, _ = self.repo.run()
        self.assertEqual(code, 1)
        self.assertEqual(lines, ['CHANGELOG.md:5: version 0.9.0, but %s says 1.0.0' % check.PLUGIN_JSON])

    def test_marketplace_off(self):
        self.repo.write_json(check.MARKETPLACE_JSON, {'plugins': [{'name': 'deckhand', 'version': '0.9.0'}]})
        code, lines, _ = self.repo.run()
        self.assertEqual(code, 1)
        self.assertEqual(lines, ['%s: version 0.9.0, but %s says 1.0.0' % (check.MARKETPLACE_JSON, check.PLUGIN_JSON)])

    def test_plugin_json_off_is_reported_against_it(self):
        self.repo.write_json(check.PLUGIN_JSON, {'name': 'deckhand', 'version': '1.1.0'})
        code, lines, _ = self.repo.run()
        self.assertEqual(code, 1)
        self.assertEqual(len(lines), 7)
        self.assertTrue(all(line.endswith('says 1.1.0') for line in lines))

    def test_expect_matches(self):
        code, lines, _ = self.repo.run('--expect', '1.0.0')
        self.assertEqual((code, lines), (0, []))

    def test_expect_mismatch_reports_every_place(self):
        code, lines, _ = self.repo.run('--expect', '1.1.0')
        self.assertEqual(code, 1)
        self.assertEqual(len(lines), 8)
        self.assertIn('%s: version 1.0.0, but --expect says 1.1.0' % check.PLUGIN_JSON, lines)

    def test_expect_must_be_a_version(self):
        code, lines, err = self.repo.run('--expect', 'v1.0')
        self.assertEqual((code, lines), (2, []))
        self.assertIn('--expect must be X.Y.Z', err)

    def test_missing_file(self):
        os.remove(os.path.join(self.repo.root, 'README.ko.md'))
        code, lines, _ = self.repo.run()
        self.assertEqual(code, 2)
        self.assertEqual(lines, ['README.ko.md: file not found'])

    def test_missing_plugin_json(self):
        os.remove(os.path.join(self.repo.root, check.PLUGIN_JSON))
        code, lines, _ = self.repo.run()
        self.assertEqual(code, 2)
        self.assertEqual(lines, ['%s: file not found' % check.PLUGIN_JSON])

    def test_readme_without_badge(self):
        self.repo.write('README.md', '# Deckhand\n')
        code, lines, _ = self.repo.run()
        self.assertEqual(code, 2)
        self.assertEqual(lines, ['README.md: no version badge (badge/version-X.Y.Z-)'])

    def test_extra_readme_language_is_checked(self):
        self.repo.readme('README.de.md', '0.9.0')
        code, lines, _ = self.repo.run()
        self.assertEqual(code, 1)
        self.assertEqual(lines, ['README.de.md:9: version 0.9.0, but %s says 1.0.0' % check.PLUGIN_JSON])

    def test_invalid_json(self):
        self.repo.write(check.MARKETPLACE_JSON, '{')
        code, lines, _ = self.repo.run()
        self.assertEqual(code, 2)
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith('%s: invalid JSON' % check.MARKETPLACE_JSON))


if __name__ == '__main__':
    unittest.main()

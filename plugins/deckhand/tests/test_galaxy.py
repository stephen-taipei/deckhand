"""Tests for bin/galaxy.py. Run: python3 -m unittest discover -s tests -p 'test_*.py'

Black-box against a made-up install: a fake `node` on PATH, and in DECKHAND_GALAXY_HOME a small MCP
server where the npm package would be. No network, no npm, no browser.
"""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'bin', 'galaxy.py')
BIN = os.path.join('node_modules', '@stephen.taipei', 'intent-galaxy', 'dist', 'apps', 'cli', 'bin', 'intent-galaxy.mjs')

# Stands in for the package's server: it answers tools/call only after a pause, as intent_open_galaxy
# does while it waits for the lock, and exits as soon as its stdin closes, as the real one does.
FAKE_SERVER = r'''
import json, sys, time
for line in sys.stdin:
    m = json.loads(line)
    if m.get('method') == 'initialize':
        print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': {'capabilities': {}}}), flush=True)
    elif m.get('method') == 'tools/call':
        time.sleep(0.5)
        args = m['params']['arguments']
        print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': {'content': [{'type': 'text', 'text': 'LOCKED ' + args.get('goal', '')}]}}), flush=True)
sys.exit(0)
'''


class GalaxyCase(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.galaxy_home = os.path.join(self.tmp, 'galaxy')
        self.path = os.path.join(self.tmp, 'path')
        os.makedirs(self.path)
        self.env = {k: v for k, v in os.environ.items() if k not in ('DECKHAND_LANG',)}
        # Only the fake tools on PATH, so the real node and npm of the machine never count.
        self.env.update(DECKHAND_GALAXY_HOME=self.galaxy_home, DECKHAND_GALAXY_PATH_ONLY='1', PATH=self.path, PYTHONDONTWRITEBYTECODE='1', HOME=self.tmp)

    def fake_node(self, version='v22.18.0'):
        """A `node` that reports `version` and runs a script with this Python, the fake server being Python."""
        path = os.path.join(self.path, 'node')
        with open(path, 'w') as f:
            f.write('#!/bin/sh\nif [ "$1" = "--version" ]; then echo %s; exit 0; fi\nexec %s "$@"\n' % (version, sys.executable))
        os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)

    def fake_package(self):
        path = os.path.join(self.galaxy_home, BIN)
        os.makedirs(os.path.dirname(path))
        with open(path, 'w') as f:
            f.write(FAKE_SERVER)
        with open(os.path.join(self.galaxy_home, 'node_modules', '@stephen.taipei', 'intent-galaxy', 'package.json'), 'w') as f:
            json.dump({'version': '0.1.3'}, f)

    def run_tool(self, *args, stdin=''):
        return subprocess.run(['/bin/sh', '-c', 'exec "$0" "$@"', sys.executable, SCRIPT] + list(args), input=stdin,
                              capture_output=True, text=True, env=self.env, timeout=60)


class StatusTests(GalaxyCase):
    def test_without_node_nothing_is_installed_and_the_install_refuses(self):
        s = json.loads(self.run_tool('status').stdout)
        self.assertEqual((s['node'], s['nodeOk'], s['installed']), (None, False, False))
        done = self.run_tool('install')
        self.assertEqual(done.returncode, 1)
        self.assertEqual(json.loads(done.stdout)['error'], 'node')
        self.assertFalse(os.path.exists(self.galaxy_home), 'nothing is written without Node')

    def test_an_old_node_is_not_enough(self):
        self.fake_node('v22.17.9')
        s = json.loads(self.run_tool('status').stdout)
        self.assertEqual((s['node'], s['nodeOk'], s['needs']), ('22.17.9', False, '22.18'))

    def test_the_package_in_deckhands_folder_counts_as_installed(self):
        self.fake_node()
        self.fake_package()
        s = json.loads(self.run_tool('status').stdout)
        self.assertEqual((s['nodeOk'], s['installed'], s['version'], s['home']), (True, True, '0.1.3', self.galaxy_home))


class CallTests(GalaxyCase):
    def test_a_call_keeps_stdin_open_until_the_slow_answer_comes(self):
        self.fake_node()
        self.fake_package()
        done = self.run_tool('call', 'intent_open_galaxy', '--cwd', self.tmp, stdin=json.dumps({'goal': 'dishwasher', 'analysis': {}}))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout), {'text': 'LOCKED dishwasher', 'isError': False})

    def test_refusals_are_in_the_language_asked_for(self):
        self.fake_node()
        self.fake_package()
        self.assertIn('不認得的 Intent Galaxy 工具', json.loads(self.run_tool('call', 'nope', '--lang', 'zh-Hant-TW').stdout)['text'])
        self.assertIn('Unknown Intent Galaxy tool', json.loads(self.run_tool('call', 'nope').stdout)['text'])
        bad = json.loads(self.run_tool('call', 'intent_spawner_prompt', stdin='{not json').stdout)
        self.assertTrue(bad['isError'])

    def test_without_the_package_the_call_says_how_to_install_it(self):
        self.fake_node()
        out = json.loads(self.run_tool('call', 'intent_spawner_prompt', stdin='{}').stdout)
        self.assertEqual(out['isError'], True)
        self.assertIn('iG', out['text'])


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Runs Intent Galaxy (npm @stephen.taipei/intent-galaxy) for Deckhand's iG button, without an MCP entry
in the person's Claude Code config.

  galaxy.py status                 JSON: the Node version, whether it is new enough, whether the package is
                                   installed in Deckhand's own folder, and its version
  galaxy.py install                installs the package there with npm (scripts off), then prints status
  galaxy.py call TOOL --cwd DIR [--lang L]   reads the tool's arguments as JSON on stdin, starts the package's MCP
                                   server, calls TOOL once and prints {"text": ..., "isError": ...}

The package lives in ~/.deckhand/intent-galaxy (DECKHAND_GALAXY_HOME overrides it); removing that folder
uninstalls it. The server exits when its stdin closes, so `call` keeps stdin open until the answer comes:
intent_open_galaxy answers only once the person locks the galaxy in the browser (it gives up after 30 min).
"""
import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # loading i18n.py must not leave a __pycache__ in bin/


def _load_i18n():
    spec = importlib.util.spec_from_file_location('deckhand_i18n', os.path.join(HERE, 'i18n.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


i18n = _load_i18n()
LOCALE = 'en'


def _(key, **values):
    return i18n.t(LOCALE, key, **values)


PACKAGE = '@stephen.taipei/intent-galaxy'
BIN = os.path.join('node_modules', '@stephen.taipei', 'intent-galaxy', 'dist', 'apps', 'cli', 'bin', 'intent-galaxy.mjs')
NEEDS = (22, 18)
TOOLS = ('intent_spawner_prompt', 'intent_open_galaxy')
SEARCH = ('~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')


def home():
    return os.path.expanduser(os.environ.get('DECKHAND_GALAXY_HOME') or '~/.deckhand/intent-galaxy')


def which(name):
    """The CLI on PATH, else in the usual install places: the desktop app's PATH may lack them."""
    found = shutil.which(name)
    if found or os.environ.get('DECKHAND_GALAXY_PATH_ONLY'):  # the tests: only their fake tools count
        return found
    for d in SEARCH:
        path = os.path.join(os.path.expanduser(d), name)
        if os.access(path, os.X_OK):
            return path
    return None


def node_version(node):
    try:
        out = subprocess.run([node, '--version'], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.match(r'^v?(\d+)\.(\d+)\.(\d+)', out)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def installed_version():
    try:
        with open(os.path.join(home(), 'node_modules', '@stephen.taipei', 'intent-galaxy', 'package.json'), encoding='utf-8') as f:
            return json.load(f).get('version') or ''
    except (OSError, ValueError):
        return ''


def status():
    node = which('node')
    version = node_version(node) if node else None
    return {
        'node': '.'.join(map(str, version)) if version else None,
        'nodeOk': bool(version) and version[:2] >= NEEDS,
        'needs': '%d.%d' % NEEDS,
        'npm': bool(which('npm')),
        'installed': os.path.isfile(os.path.join(home(), BIN)),
        'version': installed_version(),
        'home': home(),
    }


def cmd_status(_args):
    print(json.dumps(status()))
    return 0


def cmd_install(_args):
    s = status()
    if not s['nodeOk']:
        print(json.dumps(dict(s, error='node')))
        return 1
    npm = which('npm')
    if not npm:
        print(json.dumps(dict(s, error='npm')))
        return 1
    os.makedirs(home(), exist_ok=True)
    # The package has no dependencies and no install scripts; --ignore-scripts keeps it that way.
    p = subprocess.run([npm, 'install', '--prefix', home(), '--ignore-scripts', '--no-fund', '--no-audit', PACKAGE],
                       capture_output=True, text=True, timeout=300)
    s = status()
    if p.returncode != 0 or not s['installed']:
        print(json.dumps(dict(s, error='npm-install', detail=(p.stderr or p.stdout).strip().splitlines()[-1:] or [''])))
        return 1
    print(json.dumps(s))
    return 0


def cmd_call(args):
    if args.tool not in TOOLS:
        print(json.dumps({'text': _('galaxy.err.unknown_tool', tool=args.tool), 'isError': True}))
        return 2
    s = status()
    if not s['installed'] or not s['nodeOk']:
        print(json.dumps({'text': _('galaxy.err.not_installed'), 'isError': True}))
        return 1
    try:
        arguments = json.loads(sys.stdin.read() or '{}')
    except ValueError as e:
        print(json.dumps({'text': _('galaxy.err.bad_args', error=e), 'isError': True}))
        return 2
    child = subprocess.Popen([which('node'), os.path.join(home(), BIN)], cwd=args.cwd or None,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)

    def send(message):
        child.stdin.write(json.dumps(message) + '\n')
        child.stdin.flush()

    try:
        send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
              'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'deckhand', 'version': '1'}}})
        send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        send({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': args.tool, 'arguments': arguments}})
        for line in child.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if message.get('id') != 2:
                continue
            if 'error' in message:
                print(json.dumps({'text': message['error'].get('message', 'error'), 'isError': True}))
                return 1
            result = message.get('result') or {}
            text = '\n'.join(c.get('text', '') for c in result.get('content') or [] if c.get('type') == 'text')
            print(json.dumps({'text': text, 'isError': bool(result.get('isError'))}))
            return 0
        print(json.dumps({'text': _('galaxy.err.no_answer'), 'isError': True}))
        return 1
    finally:
        try:
            child.stdin.close()
        except OSError:
            pass
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()


def main():
    parser = argparse.ArgumentParser(prog='galaxy.py')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status').set_defaults(func=cmd_status)
    sub.add_parser('install').set_defaults(func=cmd_install)
    call = sub.add_parser('call')
    call.add_argument('tool')
    call.add_argument('--cwd', default='')
    call.add_argument('--lang', default=None)
    call.set_defaults(func=cmd_call)
    args = parser.parse_args()
    global LOCALE
    LOCALE = i18n.resolve(getattr(args, 'lang', None))
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())

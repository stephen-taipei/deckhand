#!/usr/bin/env python3
"""Check that every file that states Deckhand's version states the same one.

Places checked, relative to the repository root:
  - plugins/deckhand/.claude-plugin/plugin.json: "version";
  - .claude-plugin/marketplace.json: the "version" of the deckhand entry in
    "plugins";
  - README.md and every README.<lang>.md: the shields.io badge
    `badge/version-X.Y.Z-`;
  - CHANGELOG.md: the newest `## X.Y.Z — date` heading.

plugin.json is the reference. With --expect X.Y.Z, every place, plugin.json
included, must state that version instead.

A problem is printed as `path[:line]: message`, one line each. Exit status:
0 consistent, 1 a version differs, 2 a file is missing or states no version.

Every regular expression bounds its repetitions, so a long line cannot cause
catastrophic backtracking.
"""

import argparse
import glob
import json
import os
import re
import sys

PLUGIN_JSON = 'plugins/deckhand/.claude-plugin/plugin.json'
MARKETPLACE_JSON = '.claude-plugin/marketplace.json'
CHANGELOG = 'CHANGELOG.md'
READMES = ('README.md', 'README.zh-TW.md', 'README.zh-CN.md', 'README.ja.md', 'README.ko.md')

VERSION = r'\d{1,9}\.\d{1,9}\.\d{1,9}'
VERSION_RE = re.compile(r'^' + VERSION + r'$')
BADGE_RE = re.compile(r'badge/version-(' + VERSION + r')-')
# `## 1.0.0 — 2026-10-08`, also `## [1.0.0] - ...`; `## Unreleased` is skipped.
CHANGELOG_RE = re.compile(r'^## {1,4}\[?(' + VERSION + r')\]?(?:\s|$)')

DEFAULT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Problem(Exception):
    """A file is missing, unreadable or states no version."""


class Found(object):
    def __init__(self, path, line, version):
        self.path = path
        self.line = line
        self.version = version

    def where(self):
        return '%s:%d' % (self.path, self.line) if self.line else self.path


def read(root, rel):
    try:
        with open(os.path.join(root, rel), encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        raise Problem('%s: file not found' % rel)
    except (OSError, UnicodeDecodeError) as exc:
        raise Problem('%s: cannot read: %s' % (rel, exc))


def read_json(root, rel):
    try:
        return json.loads(read(root, rel))
    except ValueError as exc:
        raise Problem('%s: invalid JSON: %s' % (rel, exc))


def json_version(rel, value):
    if not isinstance(value, str) or not VERSION_RE.match(value):
        raise Problem('%s: no X.Y.Z "version" (found %r)' % (rel, value))
    return value


def plugin_version(root):
    data = read_json(root, PLUGIN_JSON)
    if not isinstance(data, dict):
        raise Problem('%s: not a JSON object' % PLUGIN_JSON)
    return data.get('name'), [Found(PLUGIN_JSON, 0, json_version(PLUGIN_JSON, data.get('version')))]


def marketplace_version(root, name):
    data = read_json(root, MARKETPLACE_JSON)
    plugins = data.get('plugins') if isinstance(data, dict) else None
    entries = [p for p in plugins or [] if isinstance(p, dict) and p.get('name') == (name or 'deckhand')]
    if not entries:
        raise Problem('%s: no "plugins" entry named %s' % (MARKETPLACE_JSON, name or 'deckhand'))
    return [Found(MARKETPLACE_JSON, 0, json_version(MARKETPLACE_JSON, entries[0].get('version')))]


def badge_versions(root, rel):
    found = []
    for line_no, line in enumerate(read(root, rel).splitlines(), 1):
        for match in BADGE_RE.finditer(line):
            found.append(Found(rel, line_no, match.group(1)))
    if not found:
        raise Problem('%s: no version badge (badge/version-X.Y.Z-)' % rel)
    return found


def changelog_version(root):
    for line_no, line in enumerate(read(root, CHANGELOG).splitlines(), 1):
        match = CHANGELOG_RE.match(line)
        if match:
            return [Found(CHANGELOG, line_no, match.group(1))]
    raise Problem('%s: no "## X.Y.Z" release heading' % CHANGELOG)


def readme_files(root):
    extra = sorted(os.path.basename(p) for p in glob.glob(os.path.join(root, 'README.*.md')))
    return list(READMES) + [name for name in extra if name not in READMES]


def collect(root):
    """Return (found, problems): every stated version, and every file that could not be checked."""
    found, problems = [], []
    name = None
    try:
        name, versions = plugin_version(root)
        found.extend(versions)
    except Problem as exc:
        problems.append(str(exc))
    checks = [lambda: marketplace_version(root, name)]
    checks += [lambda rel=rel: badge_versions(root, rel) for rel in readme_files(root)]
    checks.append(lambda: changelog_version(root))
    for check in checks:
        try:
            found.extend(check())
        except Problem as exc:
            problems.append(str(exc))
    return found, problems


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Check that plugin.json, marketplace.json, the README badges and CHANGELOG.md state one version.")
    parser.add_argument('--expect', metavar='X.Y.Z', help='also require this exact version everywhere')
    parser.add_argument('--root', default=DEFAULT_ROOT, help='repository root (default: the parent of scripts/)')
    args = parser.parse_args(argv)

    if args.expect is not None and not VERSION_RE.match(args.expect):
        sys.stderr.write('check-version: --expect must be X.Y.Z, got %r\n' % args.expect)
        return 2

    found, problems = collect(args.root)
    for problem in problems:
        print(problem)

    reference = args.expect
    source = '--expect'
    if reference is None:
        reference = next((f.version for f in found if f.path == PLUGIN_JSON), None)
        source = PLUGIN_JSON
    mismatches = [f for f in found if reference is not None and f.version != reference]
    for f in mismatches:
        print('%s: version %s, but %s says %s' % (f.where(), f.version, source, reference))

    if problems:
        return 2
    if mismatches:
        sys.stderr.write('check-version: %d of %d place(s) differ from %s\n'
                         % (len(mismatches), len(found), reference))
        return 1
    sys.stderr.write('check-version: %s in all %d place(s)\n' % (reference, len(found)))
    return 0


if __name__ == '__main__':
    sys.exit(main())

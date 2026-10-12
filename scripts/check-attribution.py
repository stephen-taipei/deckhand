#!/usr/bin/env python3
"""Check that no commit credits an AI assistant as an author or co-author.

GitHub lists everyone who authored or co-authored a commit on the default
branch as a contributor of the repository. A commit made by a Claude Code
cloud session is authored by `Claude <noreply@anthropic.com>` and carries
`Co-Authored-By` and `Claude-Session` trailers, so merging one adds `claude`
to that list. This check fails on such a commit before it is merged.

A commit is refused when:
  - its author or committer email is an `@anthropic.com` address;
  - its message has a `Co-Authored-By` trailer naming Claude or an
    `@anthropic.com` address (a human co-author is fine);
  - its message has a `Claude-Session` trailer or a "Generated with Claude
    Code" line.

Usage: check-attribution.py [REVISION_RANGE]. Without a range, every commit
reachable from HEAD is checked. A problem is printed as `sha: message`, one
line each. Exit status: 0 clean, 1 a commit is refused, 2 git failed.

Every regular expression bounds its repetitions, so a long line cannot cause
catastrophic backtracking.
"""

import os
import re
import subprocess
import sys

ANTHROPIC = re.compile(r'@anthropic\.com\s{0,4}>?\s{0,4}$', re.IGNORECASE)
CO_AUTHOR = re.compile(r'^co-authored-by:[ \t]{0,8}(.{0,400})$', re.IGNORECASE)
SESSION = re.compile(r'^claude-session:', re.IGNORECASE)
GENERATED = re.compile(r'generated with \[?claude code\]?', re.IGNORECASE)
CLAUDE_NAME = re.compile(r'(?:^|\s)claude(?:\s|$)', re.IGNORECASE)

# Fields of one commit, NUL between fields and a record separator between commits.
FORMAT = '%H%x00%ae%x00%ce%x00%B%x1e'

DEFAULT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def problems_in(sha, author_email, committer_email, message):
    """The reasons one commit is refused, empty when it is clean."""
    found = []
    short = sha[:7]
    if ANTHROPIC.search(author_email):
        found.append('%s: author is %s' % (short, author_email))
    if ANTHROPIC.search(committer_email):
        found.append('%s: committer is %s' % (short, committer_email))
    for line in message.splitlines():
        line = line.strip()
        co = CO_AUTHOR.match(line)
        if co and (ANTHROPIC.search(co.group(1)) or CLAUDE_NAME.search(co.group(1).split('<')[0])):
            found.append('%s: co-author trailer `%s`' % (short, line))
        elif SESSION.match(line):
            found.append('%s: session trailer `%s`' % (short, line[:120]))
        elif GENERATED.search(line):
            found.append('%s: generated-with line `%s`' % (short, line[:120]))
    return found


def commits(root, revision):
    """(sha, author email, committer email, message) for each commit in `revision`."""
    out = subprocess.run(
        ['git', 'log', '--format=' + FORMAT, revision],
        cwd=root, capture_output=True, text=True, encoding='utf-8', errors='replace', check=True,
    ).stdout
    for record in out.split('\x1e'):
        record = record.strip('\n')
        if not record:
            continue
        sha, author, committer, message = record.split('\x00', 3)
        yield sha, author, committer, message


def check(root, revision='HEAD'):
    found = []
    for sha, author, committer, message in commits(root, revision):
        found.extend(problems_in(sha, author, committer, message))
    return found


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    revision = args[0] if args else 'HEAD'
    root = os.environ.get('CHECK_ATTRIBUTION_ROOT', DEFAULT_ROOT)
    try:
        found = check(root, revision)
    except (subprocess.CalledProcessError, OSError) as error:
        print('check-attribution: git log %s failed: %s' % (revision, getattr(error, 'stderr', '') or error), file=sys.stderr)
        return 2
    for line in found:
        print(line)
    if found:
        print('check-attribution: %d problem(s). Re-author the commit and drop the trailer before merging.' % len(found), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

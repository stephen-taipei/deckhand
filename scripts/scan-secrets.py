#!/usr/bin/env python3
"""Scan files for secrets and personal data before they are committed or published.

By default every file tracked by git is scanned. Give paths (files or folders) to
scan those instead.

What is reported:
  - private keys, provider tokens (OpenAI/Anthropic style sk-, GitHub, AWS,
    Slack, Google API keys), JWTs and Bearer tokens;
  - KEY / SECRET / TOKEN / PASSWORD assignments whose value looks real;
  - credentials inside URLs, for any scheme (user:password@host);
  - email addresses, except *@users.noreply.github.com, reserved example
    domains (example.com/.org/.net, .test, .example, .invalid, .localhost) and
    the non-personal local parts git, noreply and no-reply;
  - absolute home paths (/Users/<name>/, /home/<name>/, C:\\Users\\<name>\\),
    except the placeholder names me, user, you and runner;
  - deny terms gathered at run time and never stored in the repository: the OS
    user name, `git config --global user.email` (and its local part), and the
    lines of an optional untracked file given with --deny-file.

A finding is printed as `path:line: rule: preview`. The preview masks the match,
so the full secret is never printed. Exit status: 0 clean, 1 findings, 2 error.

A line that carries the marker `scan-secrets: allow` is skipped for test
fixtures and documented examples. The marker never hides a deny-term hit.

Every regular expression bounds its repetitions, so a long line cannot cause
catastrophic backtracking.
"""

import argparse
import getpass
import math
import os
import re
import subprocess
import sys
from collections import Counter

ALLOW_MARKER = 'scan-secrets: allow'
MAX_FILE_BYTES = 5 * 1024 * 1024
BINARY_SNIFF_BYTES = 8192
PREVIEW_CONTEXT = 40

PLACEHOLDER_USERS = frozenset(['me', 'user', 'you', 'runner'])
# Account names that identify nobody (CI runners, containers); never used as deny terms.
GENERIC_ACCOUNTS = PLACEHOLDER_USERS | frozenset([
    'root', 'admin', 'administrator', 'ubuntu', 'vscode', 'codespace', 'node',
    'docker', 'ci', 'build', 'builder', 'jenkins', 'circleci', 'travis', 'gitpod',
])
ALLOWED_EMAIL_DOMAINS = ('example.com', 'example.org', 'example.net')
RESERVED_EMAIL_TLDS = ('test', 'example', 'invalid', 'localhost')
ALLOWED_EMAIL_LOCALS = frozenset(['git', 'noreply', 'no-reply'])
NOREPLY_GITHUB = 'users.noreply.github.com'

CODE_EXTENSIONS = frozenset([
    '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.rs', '.java',
    '.kt', '.rb', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php',
    '.scala', '.lua', '.dart',
])

PLACEHOLDER_WORDS = (
    'example', 'placeholder', 'changeme', 'change_me', 'change-me', 'your', 'xxx',
    '***', '...', 'dummy', 'sample', 'redacted', 'fake', 'mock', 'todo',
    'replace', 'secret', 'password', 'passwd', 'token', 'notreal', 'not-real',
)
PLACEHOLDER_VALUES = frozenset(['none', 'null', 'nil', 'undefined', 'true', 'false'])
PLACEHOLDER_PASSWORDS = frozenset([
    'pass', 'passwd', 'password', 'pw', 'pwd', 'secret', 'token', 'changeme',
    'xxx', 'xxxx', '***', '****', 'x', 'p', 'pass123', 'password123',
])


# ── helpers ────────────────────────────────────────────────────────────────

def entropy(value):
    """Shannon entropy in bits per character."""
    if not value:
        return 0.0
    counts = Counter(value)
    total = float(len(value))
    return -sum((n / total) * math.log2(n / total) for n in counts.values())


def has_letter_and_digit(value):
    return any(c.isalpha() for c in value) and any(c.isdigit() for c in value)


def is_placeholder(value):
    """True for values that are obviously not a real secret."""
    lowered = value.lower()
    if lowered in PLACEHOLDER_VALUES:
        return True
    if value[:1] in ('$', '%', '<', '{') or '${' in value or '{{' in value:
        return True
    if 'process.env' in lowered or 'os.environ' in lowered or 'getenv' in lowered:
        return True
    if any(word in lowered for word in PLACEHOLDER_WORDS):
        return True
    return len(set(value)) < 6


def looks_real(value):
    """A value is real-looking when it mixes letters and digits or is high entropy."""
    if len(value) < 8 or is_placeholder(value):
        return False
    if has_letter_and_digit(value) and entropy(value) >= 2.5:
        return True
    return len(value) >= 16 and entropy(value) >= 3.5


def mask(secret):
    """Shows only a short prefix and the length of a matched secret."""
    keep = 4 if len(secret) >= 16 else (2 if len(secret) >= 8 else 1)
    return '%s…[%d chars]' % (secret[:keep], len(secret))


# ── rules ──────────────────────────────────────────────────────────────────
# Each rule: (name, compiled pattern, group whose span is masked, validator).
# The validator gets the match and the file path and returns True to report.

def _always(match, path):
    return True


def _token_ok(group):
    def check(match, path):
        value = match.group(group)
        return has_letter_and_digit(value) and len(set(value)) >= 6
    return check


def _aws_ok(match, path):
    return 'EXAMPLE' not in match.group(0)


def _bearer_ok(match, path):
    return looks_real(match.group(1))


def _assignment_ok(match, path):
    value = match.group('value')
    quoted = bool(match.group('quote'))
    # KEY=value with an upper-case name and no spaces is env/shell style, a literal
    # even when it sits inside a string in source code.
    key = match.group('key')
    if match.string[max(0, match.start('key') - 1):match.start('key')] == '\\' and key[:1] in ('n', 'r', 't'):
        key = key[1:]  # an escaped newline or tab written in source: "\nAPI_KEY=..."
    env_style = match.group('sep') == '=' and key == key.upper()
    if not quoted and not env_style and os.path.splitext(path)[1].lower() in CODE_EXTENSIONS:
        # Unquoted in source code means a variable or a call, not a literal.
        return False
    return looks_real(value)


def is_placeholder_url_part(value):
    return value[:1] in ('$', '%', '<', '{', '*') or '${' in value or '{{' in value or set(value) <= set('x*.')


def _url_credentials_ok(match, path):
    password = match.group('password')
    if password.lower() in PLACEHOLDER_PASSWORDS:
        return False
    return not is_placeholder_url_part(password)


# The text right before user:password@ inside a URL; the URL rule owns that part.
URL_USERINFO_BEFORE = re.compile(r'://[^\s/@]{0,128}:$')


def _email_ok(match, path):
    local = match.group('local').lower()
    domain = match.group('domain').lower()
    before = match.string[max(0, match.start() - 160):match.start()]
    if URL_USERINFO_BEFORE.search(before):
        return False
    if before.endswith('\\') and local[:1] in ('n', 'r', 't'):
        local = local[1:]  # an escaped newline or tab written in source: "\ngit@..."
    if local in ALLOWED_EMAIL_LOCALS:
        return False
    if domain == NOREPLY_GITHUB or domain.endswith('.' + NOREPLY_GITHUB):
        return False
    for allowed in ALLOWED_EMAIL_DOMAINS:
        if domain == allowed or domain.endswith('.' + allowed):
            return False
    if domain.rsplit('.', 1)[-1] in RESERVED_EMAIL_TLDS:
        return False
    # Retina image names such as icon@2x.png are not addresses.
    if re.match(r'^\d{1,2}x\.(?:png|jpe?g|gif|webp|svg|avif)$', domain):
        return False
    return True


def _home_ok(match, path):
    return match.group('name').lower() not in PLACEHOLDER_USERS


RULES = [
    ('private-key',
     re.compile(r'-----BEGIN (?:[A-Z0-9]{1,20} ){0,3}PRIVATE KEY(?: BLOCK)?-----'),
     0, _always),
    ('sk-token',
     re.compile(r'(?<![A-Za-z0-9_-])sk-(?P<body>(?:ant-|proj-|live-|test-|svcacct-)?[A-Za-z0-9_-]{20,250})'),
     0, _token_ok('body')),
    ('github-token',
     re.compile(r'(?<![A-Za-z0-9_])(?:ghp|gho|ghs|ghu|ghr)_(?P<body>[A-Za-z0-9]{30,251})(?![A-Za-z0-9_])'),
     0, _token_ok('body')),
    ('github-pat',
     re.compile(r'(?<![A-Za-z0-9_])github_pat_(?P<body>[A-Za-z0-9_]{22,251})(?![A-Za-z0-9_])'),
     0, _token_ok('body')),
    ('aws-access-key',
     re.compile(r'(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])'),
     0, _aws_ok),
    ('slack-token',
     re.compile(r'(?<![A-Za-z0-9_-])xox[abposre]-(?P<body>[A-Za-z0-9-]{10,250})'),
     0, _token_ok('body')),
    ('google-api-key',
     re.compile(r'(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])'),
     0, _always),
    ('jwt',
     re.compile(r'(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,2000}'),
     0, _always),
    ('bearer-token',
     re.compile(r'\b[Bb]earer[ \t]{1,5}([A-Za-z0-9._~+/-]{16,500}={0,2})'),
     1, _bearer_ok),
    ('url-credentials',
     re.compile(
         r'(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,30}://'
         r'(?P<user>[^\s/:@\'"<>`]{0,128}):(?P<password>[^\s/@\'"<>`]{1,256})@'
         r'[A-Za-z0-9.-]{1,253}'),
     'password', _url_credentials_ok),
    ('secret-assignment',
     re.compile(
         r'(?i)(?<![A-Za-z0-9_.-])(?P<key>[A-Za-z0-9_.-]{0,40}'
         r'(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|private[_-]?key|auth[_-]?key)'
         r'[A-Za-z0-9_.-]{0,40})["\']?(?P<sep>[ \t]{0,5}(?::=|=>|:|=)[ \t]{0,5})'
         r'(?P<quote>["\'`]?)(?P<value>[^\s"\'`;,(){}\[\]<>\\]{8,200})'),
     'value', _assignment_ok),
    ('email',
     re.compile(
         r'(?<![A-Za-z0-9._%+-])(?P<local>[A-Za-z0-9._%+-]{1,64})@'
         r'(?P<domain>[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24})(?![A-Za-z0-9-])'),
     0, _email_ok),
    ('home-path',
     re.compile(r'(?<![\w.~-])(?:/Users|/home)/(?P<name>[A-Za-z0-9._-]{1,64})/'),
     'name', _home_ok),
    ('home-path',
     re.compile(r'(?<![A-Za-z0-9])[A-Za-z]:(?:\\\\|\\)Users(?:\\\\|\\)(?P<name>[A-Za-z0-9._ -]{1,64})(?:\\\\|\\)'),
     'name', _home_ok),
]


# ── runtime deny terms ─────────────────────────────────────────────────────

def _git(args, cwd=None):
    try:
        out = subprocess.run(['git'] + args, cwd=cwd, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, check=False)
    except OSError:
        return None
    if out.returncode != 0:
        return None
    return out.stdout.decode('utf-8', 'replace')


def usable_deny_term(term):
    term = term.strip()
    return len(term) >= 3 and term.lower() not in GENERIC_ACCOUNTS


def runtime_deny_terms():
    """OS user name and the global git email; gathered now, never written anywhere."""
    terms = []
    names = set()
    try:
        names.add(getpass.getuser())
    except Exception:  # getuser raises when no user name source exists
        pass
    for var in ('USER', 'LOGNAME', 'USERNAME'):
        if os.environ.get(var):
            names.add(os.environ[var])
    terms.extend(sorted(names))
    email = (_git(['config', '--global', 'user.email']) or '').strip()
    if email and NOREPLY_GITHUB not in email.lower():
        terms.append(email)
        local = email.split('@', 1)[0]
        if len(local) >= 5:
            terms.append(local)
    return [t for t in terms if usable_deny_term(t)]


def read_deny_file(path):
    terms = []
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith('#') and usable_deny_term(line):
                terms.append(line)
    return terms


def deny_patterns(terms):
    seen = set()
    patterns = []
    for term in terms:
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        patterns.append(re.compile(r'(?<![A-Za-z0-9])' + re.escape(term) + r'(?![A-Za-z0-9])', re.IGNORECASE))
    return patterns


# ── scanning ───────────────────────────────────────────────────────────────

class Finding(object):
    __slots__ = ('path', 'line', 'rule', 'start', 'end', 'preview')

    def __init__(self, path, line, rule, start, end):
        self.path = path
        self.line = line
        self.rule = rule
        self.start = start
        self.end = end
        self.preview = ''

    def __repr__(self):
        return 'Finding(%r, %d, %r)' % (self.path, self.line, self.rule)

    def format(self):
        return '%s:%d: %s: %s' % (self.path, self.line, self.rule, self.preview)


def _span(match, group):
    return match.span(group)


def _overlaps(spans, start, end):
    return any(start < s_end and s_start < end for s_start, s_end in spans)


def _preview(text, spans, start, end):
    """The line around one finding, with every finding on that line masked."""
    lo = max(0, start - PREVIEW_CONTEXT)
    hi = min(len(text), end + PREVIEW_CONTEXT)
    out = []
    pos = lo
    for s_start, s_end in sorted(spans):
        if s_end <= lo or s_start >= hi:
            continue
        s_start, s_end = max(s_start, lo), min(s_end, hi)
        if s_start < pos:
            continue
        out.append(text[pos:s_start])
        out.append(mask(text[s_start:s_end]))
        pos = s_end
    out.append(text[pos:hi])
    body = ''.join(out).strip()
    return ('…' if lo > 0 else '') + body + ('…' if hi < len(text) else '')


def scan_line(path, line_no, text, deny=()):
    """Returns the findings of one line."""
    findings = []
    spans = []
    for pattern in deny:
        for match in pattern.finditer(text):
            findings.append(Finding(path, line_no, 'deny-term', match.start(), match.end()))
            spans.append(match.span())
    if ALLOW_MARKER not in text:
        for name, pattern, group, check in RULES:
            for match in pattern.finditer(text):
                start, end = _span(match, group)
                if start == end or _overlaps(spans, start, end):
                    continue
                if not check(match, path):
                    continue
                findings.append(Finding(path, line_no, name, start, end))
                spans.append((start, end))
    for finding in findings:
        finding.preview = _preview(text, spans, finding.start, finding.end)
    findings.sort(key=lambda f: f.start)
    return findings


def scan_text(path, text, deny=()):
    findings = []
    for number, line in enumerate(text.splitlines(), 1):
        findings.extend(scan_line(path, number, line, deny))
    return findings


def read_text(full_path):
    """Returns the file's text, or None for binary, oversized or unreadable files."""
    try:
        if os.path.getsize(full_path) > MAX_FILE_BYTES:
            sys.stderr.write('scan-secrets: skipped (over %d bytes): %s\n' % (MAX_FILE_BYTES, full_path))
            return None
        with open(full_path, 'rb') as fh:
            data = fh.read()
    except OSError:
        return None
    if b'\0' in data[:BINARY_SNIFF_BYTES]:
        return None
    return data.decode('utf-8', 'replace')


def git_files(root, include_untracked=False):
    out = _git(['ls-files', '-z', '--cached'], cwd=root)
    if out is None:
        return None
    files = [p for p in out.split('\0') if p]
    if include_untracked:
        extra = _git(['ls-files', '-z', '--others', '--exclude-standard'], cwd=root) or ''
        files.extend(p for p in extra.split('\0') if p)
    return sorted(set(files))


def walk_paths(paths):
    skip_dirs = {'.git', 'node_modules', '__pycache__', '.venv', 'venv'}
    for given in paths:
        if os.path.isdir(given):
            for dirpath, dirnames, filenames in os.walk(given):
                dirnames[:] = sorted(d for d in dirnames if d not in skip_dirs)
                for name in sorted(filenames):
                    yield os.path.join(dirpath, name)
        elif os.path.exists(given):
            yield given
        else:
            sys.stderr.write('scan-secrets: no such file: %s\n' % given)


def is_tracked(path):
    folder = os.path.dirname(os.path.abspath(path)) or '.'
    return _git(['ls-files', '--error-unmatch', '--', os.path.abspath(path)], cwd=folder) is not None


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Scan git-tracked files (default) or the given paths for secrets and personal data.')
    parser.add_argument('paths', nargs='*', help='files or folders to scan instead of the git-tracked files')
    parser.add_argument('--deny-file', help='untracked file with extra deny terms, one per line (# starts a comment)')
    parser.add_argument('--include-untracked', action='store_true',
                        help='with the git default, also scan untracked files that are not ignored')
    parser.add_argument('--no-runtime-deny', action='store_true',
                        help='do not add the OS user name and global git email as deny terms')
    args = parser.parse_args(argv)

    terms = [] if args.no_runtime_deny else runtime_deny_terms()
    deny_file = None
    if args.deny_file:
        if not os.path.isfile(args.deny_file):
            sys.stderr.write('scan-secrets: deny file not found: %s\n' % args.deny_file)
            return 2
        if is_tracked(args.deny_file):
            sys.stderr.write('scan-secrets: the deny file is tracked by git; keep it out of the repository\n')
            return 2
        deny_file = os.path.abspath(args.deny_file)
        terms.extend(read_deny_file(args.deny_file))
    deny = deny_patterns(terms)

    if args.paths:
        targets = [(p, p) for p in walk_paths(args.paths)]
    else:
        root = (_git(['rev-parse', '--show-toplevel']) or '').strip()
        files = git_files(root, args.include_untracked) if root else None
        if files is None:
            sys.stderr.write('scan-secrets: not inside a git repository; pass paths to scan\n')
            return 2
        targets = [(rel, os.path.join(root, rel)) for rel in files]

    findings = []
    scanned = 0
    for shown, full in targets:
        if deny_file and os.path.abspath(full) == deny_file:
            continue
        text = read_text(full)
        if text is None:
            continue
        scanned += 1
        findings.extend(scan_text(shown, text, deny))

    for finding in findings:
        print(finding.format())
    if findings:
        files_hit = len(set(f.path for f in findings))
        sys.stderr.write('scan-secrets: %d finding(s) in %d file(s); %d file(s) scanned\n'
                         % (len(findings), files_hit, scanned))
        return 1
    sys.stderr.write('scan-secrets: no findings; %d file(s) scanned, %d deny term(s)\n' % (scanned, len(deny)))
    return 0


if __name__ == '__main__':
    sys.exit(main())

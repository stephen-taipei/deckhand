#!/usr/bin/env python3
"""Delegate helper (deckhand): the exact parts of handing a task to another AI model.

The main agent decides what to hand over, writes the brief, reviews the answer and integrates it.
This tool does what must be exact: which CLI, which model id, which effort, read-only mode, the
secrets check, the time limit, and a record of what was sent and what came back.

  delegate.py run --tool codex|agent|agy --model MODEL --effort EFFORT [--label LABEL] [--name NAME]
                  [--lang L] [--cwd DIR] [--timeout MINUTES] [--prompt-file FILE] [--dry-run]
                  [--bin PATH] [--codex-home DIR] [--raw] [--web]
      Reads the brief from stdin (or --prompt-file), puts the standard rules in front of it, refuses
      it when it holds a secret, runs the tool's CLI read-only, saves brief and answer in a private
      run folder (prompt.md, answer.md, stderr.log, and meta.json: the target and, once it ends,
      the outcome; never the brief), and prints the answer.
      --raw   for a caller that writes the whole prompt (the translate tool): no standard rules in
               front of it, and stdout is the answer alone; the outcome and the CLI's last stderr
               lines go to stderr when it fails.
      --web    lets the model search the web, still read-only: codex gets -c web_search="live",
               the Cursor agent (still in ask mode) gets --auto-review, whose server-side check
               lets the safe calls such as a web search run unasked; agy's print mode already
               allows its search_web and read_url tools.
      MODEL    ^[A-Za-z0-9][A-Za-z0-9._:/@+\\-\\[\\]=,]{0,99}$
      EFFORT   minimal|low|medium|high|xhigh|max|ultra|none. codex gets it as
               -c model_reasoning_effort="EFFORT" (nothing for 'none'); for agent and agy the effort
               is part of the model id, so EFFORT is only shown.
      LABEL    1 to 6 letters or digits (default: the tool name); names the run folder.
      NAME     up to 40 printable characters, only shown (default: MODEL).
      Exit: 0 answered | 2 refused (bad option, empty or oversized brief, secret, bad --cwd)
            | 3 the CLI was not found | 4 timed out | 5 the CLI failed or answered nothing

  delegate.py check --tool codex|agent|agy [--bin PATH] [--format text|json] [--lang L]
      Is the tool's CLI found, and where. Exit 0 found | 3 not found.
      JSON: {"tool": "codex", "found": true, "path": "/abs/path" or null, "env": "DECKHAND_CODEX"}

  delegate.py list [--dir DIR]... [--limit N] [--format text|json] [--lang L]
      The run folders of the last 3 days, newest first, in the default folder and each --dir (a
      sandboxed shell may have kept its runs under another temp folder); reads only. Exit 0.
      JSON: a list of {"id", "path", "label", "started" (epoch s), "tool", "model", "effort", "name",
      "cwd", "finished", "seconds", "exit", "outcome", "has_meta", "answer_path", "answer_bytes",
      "prompt_bytes", "stderr_bytes", "has_stderr", "first_line"}; what a folder's meta.json does not
      say (folders from before it existed, a run still going) is null.

The CLI is looked up as: --bin, then env DECKHAND_CODEX / DECKHAND_AGENT / DECKHAND_AGY, then PATH,
then the usual install places (nvm for codex, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin;
cursor-agent for agent). --codex-home sets CODEX_HOME for codex (default: env CODEX_HOME, else
~/.codex). Human-readable lines follow --lang, else env DECKHAND_LANG, else English.

macOS and Linux only: on any other system (os.name is not 'posix') every command exits 2 with one
line and runs nothing.

Read-only means: codex runs with `-s read-only`, the Cursor agent in `--mode ask`, and agy in headless
print mode, which refuses every tool that was not allowed beforehand. Nothing here passes a
`--dangerously-*` flag, `--force`, `--yolo` or a writable sandbox.
"""

from __future__ import annotations

import argparse
import collections
import glob
import importlib.util
import json
import math
import os
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # importing i18n.py and handoff-state.py must not leave a __pycache__ in bin/


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


try:
    i18n = _load('deckhand_i18n', 'i18n.py')
except Exception as error:  # noqa: BLE001 - without the messages nothing can be said properly: refuse
    sys.stderr.write('delegate: cannot load %s (%s); nothing was sent.\n' % (os.path.join(HERE, 'i18n.py'), error))
    sys.exit(2)

TOOLS = ('codex', 'agent', 'agy')
TOOL_NAME = {'codex': 'Codex', 'agent': 'Cursor agent', 'agy': 'agy'}
# A path in one of these overrides the search (tests, or a CLI installed somewhere unusual).
ENV_BIN = {'codex': 'DECKHAND_CODEX', 'agent': 'DECKHAND_AGENT', 'agy': 'DECKHAND_AGY'}
# Other names the same CLI is installed under, tried after the main one.
ALIASES = {'codex': (), 'agent': ('cursor-agent',), 'agy': ()}
EFFORTS = ('minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'none')
MODEL_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/@+\-\[\]=,]{0,99}')  # used with fullmatch: no newline slips in
LABEL_RE = re.compile(r'[A-Za-z0-9]{1,6}')
NAME_MAX = 40

DEFAULT_TIMEOUT_MIN = 30.0
MAX_BRIEF_BYTES = 400_000
MAX_ARGV_BRIEF_BYTES = 200_000  # agy takes the brief as an argument
SHOWN_ANSWER_CHARS = 40_000
KEEP_RUN_SECONDS = 3 * 86400
RUN_NAME = re.compile(r'^\d{8}-\d{6}-[A-Za-z0-9]{1,6}-[0-9a-f]{4}$')
LIST_LIMIT = 50
FIRST_LINE_CHARS = 200
# meta.json's outcome, in words that do not depend on the locale.
OUTCOMES = ('answered', 'timed_out', 'failed', 'no_answer')
ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]')
PRIVATE_KEY_LINE = re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')

Target = collections.namedtuple('Target', 'tool model effort label name')

LOCALE = i18n.DEFAULT


def _(key, **values):
    return i18n.t(LOCALE, key, **values)


def fail(code, message):
    sys.stderr.write('delegate: %s\n' % message)
    sys.exit(code)


def preamble(locale):
    """The standard rules put in front of every brief, in the user's language; they ask the
    delegated model to answer in that language, named in that language."""
    def t(key, **values):
        return i18n.t(locale, key, **values)

    return '\n'.join([
        t('delegate.preamble.intro'),
        t('delegate.preamble.rule_read_only'),
        t('delegate.preamble.rule_secrets'),
        t('delegate.preamble.rule_no_chain'),
        t('delegate.preamble.rule_conclusion'),
        t('delegate.preamble.rule_language', language=t('language.name')),
        '',
        t('delegate.preamble.task'),
        '',
        '',
    ])


# ── the target ──────────────────────────────────────────────────────────────

def _shown(value, limit=60):
    """A refused value, safe to echo: control characters replaced, length capped."""
    text = ''.join(c if c.isprintable() else '?' for c in str(value))
    return text if len(text) <= limit else text[:limit] + '…'


def check_tool(tool):
    tool = tool or ''
    if tool not in TOOLS:
        fail(2, _('delegate.err.bad_tool', value=_shown(tool), choices=' | '.join(TOOLS)))
    return tool


def make_target(tool, model, effort, label=None, name=None):
    """A validated Target; refuses (exit 2) anything outside the contract."""
    tool = check_tool(tool)
    if not MODEL_RE.fullmatch(model or ''):
        fail(2, _('delegate.err.bad_model', value=_shown(model or '')))
    effort = effort or ''
    if effort not in EFFORTS:
        fail(2, _('delegate.err.bad_effort', value=_shown(effort), choices=' | '.join(EFFORTS)))
    label = tool if label is None else label
    if not LABEL_RE.fullmatch(label):
        fail(2, _('delegate.err.bad_label', value=_shown(label)))
    if name is None or not name.strip():
        name = model  # already checked above, so no length or character check
    else:
        name = name.strip()
        if len(name) > NAME_MAX or not name.isprintable():
            fail(2, _('delegate.err.bad_name'))
    return Target(tool, model, effort, label, name)


# ── finding the CLIs ────────────────────────────────────────────────────────

def _is_executable(path):
    return os.path.isfile(path) and os.access(path, os.X_OK)


def _node_version(path):
    m = re.search(r'/v(\d+)\.(\d+)\.(\d+)/', path)
    return tuple(int(n) for n in m.groups()) if m else (0, 0, 0)


def find_bin(tool, env=None, explicit=None):
    """Absolute path of the tool's CLI, or None. An explicit path (--bin, then the env override) is
    used as it is or not at all. A shell alias is invisible here, so the places a CLI is installed
    by default are tried after PATH (nvm for codex, ~/.local/bin, Homebrew, /usr/local/bin)."""
    env = os.environ if env is None else env
    override = explicit or env.get(ENV_BIN[tool])
    if override:
        override = os.path.abspath(os.path.expanduser(override))
        return override if _is_executable(override) else None
    home = os.path.expanduser('~')
    for command in (tool,) + ALIASES[tool]:
        found = shutil.which(command, path=env.get('PATH'))
        if found:
            return found
        candidates = []
        if command == 'codex':
            nvm = glob.glob(os.path.join(home, '.nvm', 'versions', 'node', '*', 'bin', 'codex'))
            candidates += sorted(nvm, key=_node_version, reverse=True)
        candidates += [os.path.join(home, '.local', 'bin', command), '/opt/homebrew/bin/' + command, '/usr/local/bin/' + command]
        found = next((c for c in candidates if _is_executable(c)), None)
        if found:
            return found
    return None


def codex_home(explicit=None, env=None):
    env = os.environ if env is None else env
    path = explicit or env.get('CODEX_HOME') or os.path.join(os.path.expanduser('~'), '.codex')
    return os.path.abspath(os.path.expanduser(path))


# ── the secrets check ───────────────────────────────────────────────────────

def _redactor():
    """handoff-state.py's `redact`: one list of secret patterns for every tool of this plugin. When it
    cannot be loaded the check cannot be made, and nothing is sent."""
    path = os.path.join(HERE, 'handoff-state.py')
    try:
        return _load('handoff_state', 'handoff-state.py').redact
    except Exception as error:  # noqa: BLE001 - any failure to load means "cannot check"
        fail(2, _('delegate.err.secret_check', path=path, error=error))


def find_secrets(text, redact=None):
    """Line numbers (1-based) that hold something shaped like a secret; [0] when only the text as a
    whole does (a multi-line key). Values are never returned."""
    redact = redact or _redactor()
    lines = [i for i, line in enumerate(text.splitlines(), 1) if redact(line)[1] > 0 or PRIVATE_KEY_LINE.search(line)]
    if not lines and redact(text)[1] > 0:
        return [0]
    return lines


# ── where things are kept ───────────────────────────────────────────────────

def base_dir(env=None):
    env = os.environ if env is None else env
    return env.get('DECKHAND_DELEGATE_DIR') or os.path.join(tempfile.gettempdir(), 'deckhand-delegate-%d' % os.getuid())


def _own_private_dir(path):
    """Create `path` (0700) if needed; refuse one that is not a real directory of this user."""
    os.makedirs(path, mode=0o700, exist_ok=True)
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
        fail(2, _('delegate.err.not_own_folder', path=path))
    os.chmod(path, 0o700)


def make_run_dir(base, label):
    _own_private_dir(base)
    path = os.path.join(base, '%s-%s-%s' % (time.strftime('%Y%m%d-%H%M%S'), label, uuid.uuid4().hex[:4]))
    os.mkdir(path, 0o700)
    return path


def prune(base, now=None, keep_seconds=KEEP_RUN_SECONDS):
    """Remove run folders (named by make_run_dir, owned by this user) untouched for `keep_seconds`."""
    now = time.time() if now is None else now
    removed = []
    try:
        names = os.listdir(base)
    except OSError:
        return removed
    for name in names:
        if not RUN_NAME.match(name):
            continue
        path = os.path.join(base, name)
        try:
            st = os.lstat(path)
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or now - st.st_mtime < keep_seconds:
                continue
            shutil.rmtree(path)
            removed.append(name)
        except OSError:
            continue
    return removed


def _write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)  # the mode above is ignored for a file that already exists (codex makes answer.md itself)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(text)


def write_meta(run_dir, meta):
    """meta.json: what `list` shows of a run. Best effort: a run is not failed for its meta."""
    try:
        _write_private(os.path.join(run_dir, 'meta.json'), json.dumps(meta, ensure_ascii=False, indent=1) + '\n')
    except OSError:
        pass


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _text(value, limit=NAME_MAX * 3):
    return _shown(value, limit) if isinstance(value, str) and value else None


def read_meta(run_dir):
    """meta.json's fields, checked; {} for a folder without one (made before it existed) or a broken one."""
    try:
        with open(os.path.join(run_dir, 'meta.json'), encoding='utf-8') as handle:
            raw = json.load(handle)
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    code = raw.get('exit')
    return {
        'tool': raw.get('tool') if raw.get('tool') in TOOLS else None,
        'model': _text(raw.get('model')),
        'effort': raw.get('effort') if raw.get('effort') in EFFORTS else None,
        'name': _text(raw.get('name')),
        'cwd': _text(raw.get('cwd'), 400),
        'started': _number(raw.get('started')),
        'finished': _number(raw.get('finished')),
        'seconds': _number(raw.get('seconds')),
        'exit': code if isinstance(code, int) and not isinstance(code, bool) else None,
        'outcome': raw.get('outcome') if raw.get('outcome') in OUTCOMES else None,
    }


def _size(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return None


def first_line(path):
    """The answer's first non-empty line, printable and cut short; '' when there is none."""
    try:
        with open(path, encoding='utf-8', errors='replace') as handle:
            for line in handle:
                text = ANSI.sub('', line).strip()
                if text:
                    return _shown(text, FIRST_LINE_CHARS)
    except OSError:
        pass
    return ''


def _started_of(name):
    try:
        return time.mktime(time.strptime(name[:15], '%Y%m%d-%H%M%S'))
    except ValueError:
        return None


def list_runs(bases, now=None, keep_seconds=KEEP_RUN_SECONDS, limit=LIST_LIMIT):
    """The run folders (named by make_run_dir, owned by this user) touched in the last `keep_seconds`,
    newest first. Reads only: pruning is `run`'s."""
    now = time.time() if now is None else now
    seen, runs = set(), []
    for base in bases:
        real = os.path.realpath(base)
        if real in seen:
            continue
        seen.add(real)
        try:
            names = os.listdir(base)
        except OSError:
            continue
        for name in names:
            if not RUN_NAME.match(name):
                continue
            path = os.path.join(base, name)
            try:
                st = os.lstat(path)
            except OSError:
                continue
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or now - st.st_mtime >= keep_seconds:
                continue
            meta = read_meta(path)
            answer = os.path.join(path, 'answer.md')
            stderr_bytes = _size(os.path.join(path, 'stderr.log'))
            runs.append({
                'id': name,
                'path': path,
                'label': name.split('-')[2],
                'started': meta.get('started') or _started_of(name),
                'tool': meta.get('tool'),
                'model': meta.get('model'),
                'effort': meta.get('effort'),
                'name': meta.get('name'),
                'cwd': meta.get('cwd'),
                'finished': meta.get('finished'),
                'seconds': meta.get('seconds'),
                'exit': meta.get('exit'),
                'outcome': meta.get('outcome'),
                'has_meta': bool(meta),
                'answer_path': answer if os.path.isfile(answer) else None,
                'answer_bytes': _size(answer),
                'prompt_bytes': _size(os.path.join(path, 'prompt.md')),
                'stderr_bytes': stderr_bytes,
                'has_stderr': bool(stderr_bytes),
                'first_line': first_line(answer),
            })
    runs.sort(key=lambda r: (r['started'] or 0, r['id']), reverse=True)
    return runs[:max(0, limit)]


# ── the command lines ───────────────────────────────────────────────────────

def build_command(target, bin_path, cwd, answer_path, timeout_s, prompt, web=False):
    """(argv, stdin text or None, argv with the brief elided, for display)."""
    if target.tool == 'codex':
        effort = [] if target.effort == 'none' else ['-c', 'model_reasoning_effort="%s"' % target.effort]
        search = ['-c', 'web_search="live"'] if web else []
        argv = [bin_path, 'exec', '-m', target.model] + effort + search + [
            '-c', 'approval_policy="never"',
            '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
            '-C', cwd, '-o', answer_path, '-',
        ]
        return argv, prompt, argv
    if target.tool == 'agent':
        # Headless ask mode declines a web search it would have to ask about; --auto-review lets it run.
        review = ['--auto-review'] if web else []
        argv = [
            bin_path, '-p', '--mode', 'ask'] + review + ['--model', target.model, '--output-format', 'text',
            '--trust', '--workspace', cwd,
        ]
        return argv, prompt, argv
    # agy: its own time limit ends a little before ours, so it can stop by itself.
    head = [bin_path, '--model', target.model, '--print-timeout=%ds' % max(1, int(timeout_s) - 5), '--disable-slash-commands']
    return head + ['-p=' + prompt], None, head + ['-p=' + _('delegate.brief_elided', chars=len(prompt))]


def _kill_group(proc):
    for sig, wait in ((signal.SIGTERM, 3), (signal.SIGKILL, 3)):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            proc.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue


def run_process(argv, stdin_text, cwd, timeout_s, stderr_path, extra_env=None):
    """(exit code, stdout, seconds, timed out). The CLI gets its own process group, so a timeout takes
    its children down with it."""
    started = time.time()
    fd = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    env = dict(os.environ, NO_COLOR='1', TERM='dumb', **(extra_env or {}))
    with os.fdopen(fd, 'wb') as err:
        proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=err, cwd=cwd, env=env, start_new_session=True,
        )
        timed_out = False
        try:
            out, _ignored = proc.communicate(stdin_text.encode('utf-8') if stdin_text is not None else None, timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_group(proc)
            try:
                out, _ignored = proc.communicate(timeout=5)
            except Exception:  # noqa: BLE001 - whatever was printed before the kill is a bonus
                out = b''
    return proc.returncode, out.decode('utf-8', 'replace'), time.time() - started, timed_out


# ── commands ────────────────────────────────────────────────────────────────

def _read_brief(args):
    if args.prompt_file:
        try:
            with open(args.prompt_file, encoding='utf-8') as handle:
                return handle.read()
        except OSError as error:
            fail(2, _('delegate.err.brief_file', error=error))
    if sys.stdin.isatty():
        fail(2, _('delegate.err.no_brief'))
    return sys.stdin.read()


def describe(target):
    key = 'delegate.target_unnamed' if target.name == target.model else 'delegate.target'
    return _(key, label=target.label, tool=TOOL_NAME[target.tool], name=target.name, model=target.model, effort=target.effort)


def _shell(argv):
    return ' '.join(shlex.quote(a) for a in argv)


def _tail(path, lines=6):
    try:
        with open(path, encoding='utf-8', errors='replace') as handle:
            kept = [ANSI.sub('', line).rstrip() for line in handle.readlines()[-lines:]]
    except OSError:
        return []
    return [line for line in kept if line]


def cmd_run(args):
    target = make_target(args.tool, args.model, args.effort, args.label, args.name)
    if not (math.isfinite(args.timeout) and args.timeout > 0):
        fail(2, _('delegate.err.bad_timeout'))
    home = codex_home(args.codex_home)
    if args.codex_home and target.tool == 'codex' and not os.path.isdir(home):
        fail(2, _('delegate.err.bad_codex_home', path=home))
    brief = _read_brief(args).strip()
    if not brief:
        fail(2, _('delegate.err.empty_brief'))
    size = len(brief.encode('utf-8'))
    if size > (MAX_ARGV_BRIEF_BYTES if target.tool == 'agy' else MAX_BRIEF_BYTES):
        fail(2, _('delegate.err.brief_too_long', size=size))
    cwd = os.path.realpath(args.cwd or os.getcwd())
    if not os.path.isdir(cwd):
        fail(2, _('delegate.err.bad_cwd', path=cwd))
    hits = find_secrets(brief)
    if hits:
        where = (_('delegate.secret.whole_text') if hits == [0]
                 else _('delegate.secret.lines', lines=i18n.join(LOCALE, hits[:10])))
        fail(2, _('delegate.err.secret', where=where))
    bin_path = find_bin(target.tool, explicit=args.bin)
    if not bin_path:
        fail(3, _('delegate.err.not_found', tool=TOOL_NAME[target.tool], command=target.tool, env=ENV_BIN[target.tool]))
    timeout_s = max(1.0, args.timeout * 60)
    prompt = brief + '\n' if args.raw else preamble(LOCALE) + brief + '\n'
    read_only = _('delegate.read_only')

    if args.dry_run:
        _a, _s, shown = build_command(target, bin_path, cwd, '<run>/answer.md', timeout_s, prompt, args.web)
        print(_('delegate.header.dry_run', target=describe(target), read_only=read_only))
        print(_('delegate.line.command', command=_shell(shown)))
        print(_('delegate.line.cwd', path=cwd))
        return 0

    base = base_dir()
    _own_private_dir(base)
    prune(base)
    run_dir = make_run_dir(base, target.label)
    prompt_path, answer_path, stderr_path = (os.path.join(run_dir, n) for n in ('prompt.md', 'answer.md', 'stderr.log'))
    _write_private(prompt_path, prompt)
    meta = {'version': 1, 'label': target.label, 'tool': target.tool, 'model': target.model, 'effort': target.effort,
            'name': target.name, 'cwd': cwd, 'raw': bool(args.raw), 'started': round(time.time(), 3)}
    write_meta(run_dir, meta)
    argv, stdin_text, shown = build_command(target, bin_path, cwd, answer_path, timeout_s, prompt, args.web)
    extra_env = {'CODEX_HOME': home} if target.tool == 'codex' else None
    code, stdout, seconds, timed_out = run_process(argv, stdin_text, cwd, timeout_s, stderr_path, extra_env)

    answer = ''
    if target.tool == 'codex' and os.path.isfile(answer_path):
        with open(answer_path, encoding='utf-8', errors='replace') as handle:
            answer = handle.read()
    answer = ANSI.sub('', answer if answer.strip() else stdout).strip()
    _write_private(answer_path, answer + ('\n' if answer else ''))

    outcome, exit_code, word = _('delegate.outcome.answered'), 0, 'answered'
    if timed_out:
        outcome, exit_code, word = _('delegate.outcome.timed_out', minutes='%g' % (timeout_s / 60)), 4, 'timed_out'
    elif code != 0:
        outcome, exit_code, word = _('delegate.outcome.failed', code=code), 5, 'failed'
    elif not answer:
        outcome, exit_code, word = _('delegate.outcome.no_answer'), 5, 'no_answer'
    write_meta(run_dir, dict(meta, finished=round(time.time(), 3), seconds=round(seconds, 1), exit=exit_code, outcome=word))

    if args.raw:
        if exit_code == 0:
            print(answer)
        else:
            sys.stderr.write('delegate: %s\n' % _('delegate.header.run', target=describe(target), read_only=read_only,
                                                   seconds='%.1f' % seconds, outcome=outcome))
            for line in _tail(stderr_path):
                sys.stderr.write('%s\n' % line)
        return exit_code

    print(_('delegate.header.run', target=describe(target), read_only=read_only, seconds='%.1f' % seconds, outcome=outcome))
    via = _('delegate.via.stdin') if stdin_text is not None else _('delegate.via.argument')
    print(_('delegate.line.command_sent', command=_shell(shown), chars=len(prompt), via=via))
    print(_('delegate.line.brief_file', path=prompt_path))
    print(_('delegate.line.answer_file', path=answer_path))
    if exit_code != 0:
        for line in _tail(stderr_path):
            print(_('delegate.line.stderr', line=line))
    if answer:
        shown_answer = answer if len(answer) <= SHOWN_ANSWER_CHARS else answer[:SHOWN_ANSWER_CHARS] + '\n' + _('delegate.answer.truncated')
        print(_('delegate.answer.begin'))
        print(shown_answer)
        print(_('delegate.answer.end'))
    return exit_code


def cmd_check(args):
    tool = check_tool(args.tool)
    path = find_bin(tool, explicit=args.bin)
    if args.format == 'json':
        print(json.dumps({'tool': tool, 'found': path is not None, 'path': path, 'env': ENV_BIN[tool]}, ensure_ascii=False))
    elif path:
        print(_('delegate.check.found', tool=TOOL_NAME[tool], path=path))
    else:
        print(_('delegate.check.missing', tool=TOOL_NAME[tool], command=tool, env=ENV_BIN[tool]))
    return 0 if path else 3


def _list_outcome(run):
    if run['exit'] is None:
        return _('delegate.list.no_result')
    if run['exit'] == 0:
        return _('delegate.outcome.answered')
    if run['outcome'] == 'timed_out':
        return _('delegate.list.timed_out')
    if run['outcome'] == 'no_answer':
        return _('delegate.outcome.no_answer')
    return _('delegate.outcome.failed', code=run['exit'])


def cmd_list(args):
    bases = [base_dir()] + (args.dir or [])
    runs = list_runs(bases, limit=args.limit)
    if args.format == 'json':
        print(json.dumps(runs, ensure_ascii=False))
        return 0
    if not runs:
        print(_('delegate.list.none', path=', '.join(bases)))
        return 0
    for run in runs:
        started = time.strftime('%Y-%m-%d %H:%M', time.localtime(run['started'])) if run['started'] else '?'
        who = '%s · %s' % (TOOL_NAME[run['tool']], run['name'] or run['model']) if run['tool'] else _('delegate.list.unknown')
        print(_('delegate.list.line', started=started, label=run['label'], who=who, outcome=_list_outcome(run)))
        if run['first_line']:
            print('    %s' % run['first_line'])
        print('    %s' % run['path'])
    return 0


def build_parser():
    parser = argparse.ArgumentParser(prog='delegate.py', description='Hand a task to another AI model, read-only.')
    parser.add_argument('--lang', help='language of the human-readable lines (default: env DECKHAND_LANG, else en)')
    sub = parser.add_subparsers(dest='cmd', required=True)

    def lang(p):
        p.add_argument('--lang', default=argparse.SUPPRESS, help='language of the human-readable lines')

    run = sub.add_parser('run', help='run one model on the brief from stdin')
    run.add_argument('--tool', required=True, help=' | '.join(TOOLS))
    run.add_argument('--model', required=True, help='model id, passed to the CLI as it is')
    run.add_argument('--effort', required=True, help=' | '.join(EFFORTS))
    run.add_argument('--label', help='1 to 6 letters or digits (default: the tool name)')
    run.add_argument('--name', help='display name, up to 40 characters (default: the model id)')
    lang(run)
    run.add_argument('--cwd', help='working directory of the delegated model (default: the current one)')
    run.add_argument('--timeout', type=float, default=DEFAULT_TIMEOUT_MIN, help='minutes before it is stopped (default %g)' % DEFAULT_TIMEOUT_MIN)
    run.add_argument('--prompt-file', help='read the brief from this file instead of stdin')
    run.add_argument('--dry-run', action='store_true', help='check and show the command, run nothing')
    run.add_argument('--bin', help='path of the CLI (default: env DECKHAND_CODEX/AGENT/AGY, then PATH)')
    run.add_argument('--codex-home', help='CODEX_HOME for codex (default: env CODEX_HOME, else ~/.codex)')
    run.add_argument('--raw', action='store_true', help='the brief is the whole prompt, and stdout is the answer alone')
    run.add_argument('--web', action='store_true', help='let the model search the web (still read-only)')
    run.set_defaults(func=cmd_run)

    check = sub.add_parser('check', help='is the CLI of a tool found, and where')
    check.add_argument('--tool', required=True, help=' | '.join(TOOLS))
    check.add_argument('--bin', help='path of the CLI to check instead of searching')
    check.add_argument('--format', choices=('text', 'json'), default='text')
    lang(check)
    check.set_defaults(func=cmd_check)

    listing = sub.add_parser('list', help='the run folders of the last 3 days, newest first')
    listing.add_argument('--dir', action='append', help='also list this folder of runs (repeatable); the default one is always listed')
    listing.add_argument('--limit', type=int, default=LIST_LIMIT, help='at most this many runs (default %d)' % LIST_LIMIT)
    listing.add_argument('--format', choices=('text', 'json'), default='text')
    lang(listing)
    listing.set_defaults(func=cmd_list)
    return parser


def main(argv=None):
    global LOCALE
    for stream in (sys.stdout, sys.stderr, sys.stdin):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    args = build_parser().parse_args(argv)
    LOCALE = i18n.resolve(args.lang)
    refusal = i18n.not_posix(LOCALE)
    if refusal:
        fail(2, refusal)
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())

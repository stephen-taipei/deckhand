#!/usr/bin/env python3
"""List recent user-facing Codex threads as JSON for deckhand.

Usage: codex-threads.py [--cwd DIR] [--days N] [--limit N] [--codex-home DIR] [--lang L]
Skips Guardian reviews and subagent threads. Reads only session metadata,
the thread name and the last user / assistant messages of each thread.

--codex-home is Codex's folder (default: env CODEX_HOME, else ~/.codex). The
JSON on stdout never depends on --lang (else env DECKHAND_LANG, else English);
only the note on stderr when that folder does not exist does.
"""
import argparse
import glob
import importlib.util
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # loading i18n.py must not leave a __pycache__ in bin/


def _load_i18n():
    spec = importlib.util.spec_from_file_location('deckhand_i18n', os.path.join(HERE, 'i18n.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


i18n = _load_i18n()


def codex_home(explicit=None, env=None):
    env = os.environ if env is None else env
    path = explicit or env.get('CODEX_HOME') or os.path.join(os.path.expanduser('~'), '.codex')
    return os.path.abspath(os.path.expanduser(path))


def last_messages(path):
    user = assistant = ''
    with open(path, encoding='utf-8', errors='ignore') as f:
        for line in f:
            if '"role":"user"' not in line and '"role":"assistant"' not in line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            p = o.get('payload') or {}
            if o.get('type') != 'response_item' or p.get('type') != 'message':
                continue
            text = '\n'.join(
                x.get('text', '') for x in p.get('content') or [] if isinstance(x, dict)
            ).strip()
            if not text or text.startswith('<') or text.startswith('# AGENTS'):
                continue
            if p.get('role') == 'user':
                user = text
            else:
                assistant = text
    return user, assistant


def same_project(a, b):
    a, b = a.rstrip('/'), b.rstrip('/')
    return a == b or a.startswith(b + '/') or b.startswith(a + '/')


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(prog='codex-threads.py')
    ap.add_argument('--cwd', default='')
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--limit', type=int, default=12)
    ap.add_argument('--codex-home', help="Codex's folder (default: env CODEX_HOME, else ~/.codex)")
    ap.add_argument('--lang', help='language of the note on stderr (default: env DECKHAND_LANG, else en)')
    a = ap.parse_args(argv)
    home = codex_home(a.codex_home)
    if not os.path.isdir(home):
        sys.stderr.write('codex-threads: %s\n' % i18n.t(i18n.resolve(a.lang), 'threads.no_home', path=home))

    names = {}
    try:
        with open(os.path.join(home, 'session_index.jsonl'), encoding='utf-8', errors='ignore') as f:
            for line in f:
                try:
                    o = json.loads(line)
                    names[o['id']] = o.get('thread_name', '')
                except (ValueError, KeyError):
                    pass
    except OSError:
        pass

    cut = time.time() - a.days * 86400
    pattern = os.path.join(home, 'sessions', '*', '*', '*', 'rollout-*.jsonl')
    files = [p for p in glob.glob(pattern) if os.path.getmtime(p) >= cut]
    files.sort(key=os.path.getmtime, reverse=True)

    out = []
    for path in files:
        with open(path, encoding='utf-8', errors='ignore') as f:
            head = f.readline()
        try:
            meta = json.loads(head).get('payload') or {}
        except ValueError:
            continue
        if isinstance(meta.get('source'), dict) or meta.get('thread_source') not in (None, 'user'):
            continue  # Guardian reviews and spawned subagents
        cwd = meta.get('cwd', '')
        if a.cwd and not same_project(cwd, a.cwd):
            continue
        tid = meta.get('id', '')
        name = names.get(tid, '')
        if name == 'Guardian review':
            continue
        user, assistant = last_messages(path)
        if not assistant:
            continue
        out.append({
            'id': tid,
            'name': (name or user.splitlines()[0] if user else name)[:60],
            'cwd': cwd,
            'updatedAt': int(os.path.getmtime(path) * 1000),
            'lastUser': user[:2000],
            'lastAssistant': assistant[:12000],
        })
        if len(out) >= a.limit:
            break
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()

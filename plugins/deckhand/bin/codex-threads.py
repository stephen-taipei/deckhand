#!/usr/bin/env python3
"""List recent user-facing Codex threads as JSON for the deckhand mod.

Usage: codex-threads.py [--cwd DIR] [--days N] [--limit N]
Skips Guardian reviews and subagent threads. Reads only session metadata,
the thread name and the last user / assistant messages of each thread.
"""
import argparse
import glob
import json
import os
import sys
import time

HOME = os.path.expanduser('~/.codex')


def last_messages(path):
    user = assistant = ''
    with open(path, errors='ignore') as f:
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cwd', default='')
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--limit', type=int, default=12)
    a = ap.parse_args()

    names = {}
    try:
        with open(os.path.join(HOME, 'session_index.jsonl')) as f:
            for line in f:
                try:
                    o = json.loads(line)
                    names[o['id']] = o.get('thread_name', '')
                except (ValueError, KeyError):
                    pass
    except OSError:
        pass

    cut = time.time() - a.days * 86400
    pattern = os.path.join(HOME, 'sessions', '*', '*', '*', 'rollout-*.jsonl')
    files = [p for p in glob.glob(pattern) if os.path.getmtime(p) >= cut]
    files.sort(key=os.path.getmtime, reverse=True)

    out = []
    for path in files:
        with open(path, errors='ignore') as f:
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

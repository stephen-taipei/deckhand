# Contributing

Thank you for helping improve Deckhand.

| [README](README.md) | **Contributing** | [Security](SECURITY.md) | [Changelog](CHANGELOG.md) |
| :---: | :---: | :---: | :---: |

The READMEs come in five languages. This contribution policy is canonical in English.

## Before you start

- Open an issue first for a new button, a new delegate CLI, a change to what leaves the user's machine, or a large change to the band.
- Keep one pull request focused on one outcome.
- Never commit credentials, tokens, private prompts, conversation history, personal email addresses or absolute home paths.
- Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Development setup

Requirements:

- Python 3.9 or newer, with no third-party packages;
- git;
- Claude Code with plugin hook modules, to try the band itself;
- optional: `gh`, `codex`, Cursor `agent` and `agy`, to try watches and delegates.

The plugin lives in [`plugins/deckhand`](plugins/deckhand). Run the local baseline from the repository root:

```bash
(cd plugins/deckhand && python3 -m unittest discover -s tests -p 'test_*.py')
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/scan-secrets.py
git diff --check
```

CI runs the same Python tests on Python 3.9 and 3.12, and the secret scan.

The TypeScript hook tests (`plugins/deckhand/tests/deckhand.test.ts`) run inside Claude Code's plugin test runner, not in CI.

## Secret scan

`scripts/scan-secrets.py` scans every git-tracked file, or the paths you pass. It reports private keys, provider tokens, `KEY`/`SECRET`/`TOKEN`/`PASSWORD` assignments with real-looking values, credentials in URLs, email addresses and absolute home paths. It prints `file:line` and a masked preview, and exits with 1 when it finds something.

It also checks for terms that only exist on your machine and are never stored in the repository: your OS user name, your `git config --global user.email`, and the lines of an untracked file you pass with `--deny-file`:

```bash
python3 scripts/scan-secrets.py --deny-file ~/.config/deckhand-deny.txt
python3 scripts/scan-secrets.py --include-untracked   # also new files you have not added yet
```

A test fixture that needs a fake secret can carry the marker `scan-secrets: allow` on the same line. Use it only for fake values. The marker never hides a deny-term hit.

## Change rules

1. Delegates stay read-only. A new delegate CLI needs its own read-only flag or mode, the secret check, and tests that prove both.
2. Exact git work belongs in scripts such as `bin/sub5.py`, not in prompts. Never force, never push.
3. Anything that sends data off the machine must be named in the README's "Privacy and safety" section.
4. A user-facing string ships in all five languages: English, 繁體中文, 简体中文, 日本語 and 한국어. Use the wording native speakers use in developer tools, not a word-for-word translation. Keep commands, paths and identifiers unchanged.
5. Bound every repetition in a regular expression that reads user text (`{1,64}`, not `+`), so a long line cannot cause catastrophic backtracking.
6. Keep runtime state outside the repository.
7. Add a test for every new guard, including the case it must refuse.

When you change the README, update all five language versions, or open an issue for the translations you could not do.

## Pull request checklist

- [ ] Scope and non-goals are explicit.
- [ ] Behavior and safety boundaries are documented.
- [ ] Focused tests cover success and failure paths.
- [ ] The Python tests pass on Python 3.9.
- [ ] `python3 scripts/scan-secrets.py` and `git diff --check` pass.
- [ ] User-facing text is updated in all five languages.
- [ ] No secrets, private state or personal data are included.

Small, reviewable commits are preferred. Do not combine unrelated cleanup with a behavior change.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).

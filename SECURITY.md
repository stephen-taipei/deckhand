# Security policy

| [README](README.md) | [Contributing](CONTRIBUTING.md) | **Security** | [Changelog](CHANGELOG.md) |
| :---: | :---: | :---: | :---: |

This security policy is canonical in English.

## Supported versions

| Version | Support |
| --- | --- |
| Latest release on the `deckhand` marketplace | Supported |
| Older releases | Fixes are not backported unless announced |
| Forks or locally modified copies | Not supported |

## Report a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/stephen-taipei/deckhand/security/advisories/new). Do not open a public issue for a suspected vulnerability.

Include:

- the Deckhand version and the Claude Code version;
- terminal or desktop app, operating system and Python version;
- the delegate CLI and its version, if one is involved;
- minimal steps to reproduce;
- the boundary you expected and what you observed;
- the impact and any known workaround.

Do not include live credentials, tokens, private prompts, conversation history or other people's personal data. Replace them with placeholders.

## Response

The maintainer will acknowledge a usable report, check its scope, and coordinate the fix and the disclosure. There is no fixed response-time promise.

## Security boundaries

What Deckhand enforces:

- **Read-only delegates.** Each delegate runs with its CLI's own read-only flag or mode: `codex -s read-only`, Cursor `agent --mode ask`, and `agy` headless, which denies tools automatically.
- **Secret check.** A brief that contains a token, key or password is refused before it is sent.
- **Local records.** Briefs and answers are kept in a private temporary folder and pruned after 3 days.
- **Sub5 git steps** run in a script that never forces and never pushes.

What Deckhand relies on:

- the local machine, the repository, Claude Code and the installed CLIs are trusted;
- the read-only guarantee of a delegate is only as strong as that CLI's own sandbox or mode;
- the secret check is pattern-based. It catches common token, key and password formats; it cannot prove that a brief holds no sensitive data.

What leaves the machine is listed in the README's [Privacy and safety](README.md#privacy-and-safety) section. A report that Deckhand sends anything beyond that list is a security issue.

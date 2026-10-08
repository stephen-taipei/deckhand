# Changelog

| [README](README.md) | [Contributing](CONTRIBUTING.md) | [Security](SECURITY.md) | **Changelog** |
| :---: | :---: | :---: | :---: |

Notable changes to Deckhand. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## 0.5.0 — 2026-10-08

First public release, under the name **Deckhand**.

```text
/plugin marketplace add stephen-taipei/deckhand
/plugin install deckhand@deckhand
```

### Added

- **Recap** button (`通靈` in Traditional Chinese): explains the current context plainly, with analogies, in a side pane. It does not add to the conversation.
- **`⚙` settings pane** at the right end of the band: language, visible buttons, delegate targets, Sub5 model, effort and maximum, CLI paths and the Codex home folder, attribution guard, polling guard and its stop count, usage warning threshold, and translation model. Settings are stored per user.
- **Five display languages:** English, 繁體中文, 简体中文, 日本語 and 한국어. The language follows Claude Code's `language` setting by default.
- **Tooltips** on the band's buttons.
- **Editable delegate targets:** label, CLI, model ID, effort, name and on/off for each button. Buttons for CLIs that are not installed are hidden.
- Public marketplace entry, MIT license, READMEs in five languages, a secret scan (`scripts/scan-secrets.py`) and CI.

### Changed

- Renamed from the personal `stephen-ops` mod to `deckhand`.
- Desktop app: a model button fills `/model <name>` into the prompt box, so the app's own model menu stays in sync. The terminal still switches the model directly and keeps the effort level.
- The attribution guard is off by default, unless your Claude settings already turn attribution off.

## Before 0.5.0 — personal mod

Deckhand started in October 2026 as `stephen-ops`, a personal Claude Code mod that was not published. It was built to cut repeated deploy-status checks and manual copy-paste between Claude and Codex.

- Background PR, CI and URL watch (`/watch-deploy`, `watch_deploy`) that stops itself after repeated identical results, and Bash guards for blocking waits, repeated status checks and attribution trailers.
- Claude ↔ Codex handoff (`/handoff`, `/handoff-in`, the `/codex` inbox), with git facts filled in by a script instead of the model.
- The band above the prompt: usage gauges that match the app's usage card, `O` `F` `S` `H` model buttons, and Sub5 parallel workers in separate git worktrees.
- Read-only delegate buttons for Codex, Cursor agent and agy, with a secret check and private local records that are pruned after 3 days.
- `agy_translate` for localized translation.

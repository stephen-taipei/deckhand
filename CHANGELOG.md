# Changelog

| [README](README.md) | [Contributing](CONTRIBUTING.md) | [Security](SECURITY.md) | **Changelog** |
| :---: | :---: | :---: | :---: |

Notable changes to Deckhand. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **Delegate progress in the band:** while a `delegate.py run` Bash call is in flight, a row above the usage line shows its label, CLI, model and elapsed time, ticking every second. When it ends, the row shows the outcome (`✅ cL · 2:05 · answered`, `❌ cL · failed (exit 5)`) for 10 minutes or until **Clear finished**, with a **Records** button. A run moved to the background ends with its task notification or, failing that, with its run folder's `meta.json`. There is no Stop button: a plugin cannot cancel a Bash call it only observes.
- **Delegate records:** `/delegates` opens a pane listing the runs of the last 3 days (label, CLI and model, when, duration and outcome, the answer's first line), with Open (the whole answer as Markdown), Copy, and Into prompt box (refused while the box holds a draft).
- **Settings file:** the Advanced tab's new group exports the settings as pretty JSON to a path you type (default `~/.deckhand-settings.json`; a file already there is replaced only after a second press), imports such a file (checked field by field against the current settings, as the store is; it says how many settings change and applies them on **Apply**), or copies them as JSON. Only the settings object is written, nothing else the plugin stores.
- **Sub5 leftovers:** `/sub5-clean`, or **Review** in the Sub5 tab (which shows their count), lists the worktrees and branches interrupted Sub5 runs left behind and, after a confirm press, removes the safe ones.
- `bin/sub5.py list [--format text|json] [--min-age MINUTES]` reports them (path, branch, whether the worktree exists, whether the branch is merged into the base, uncommitted files, age, and what clean would do); `bin/sub5.py clean` removes worktrees with no uncommitted change and branches merged into the base (or with no commit of their own), keeps anything locked, checked out, busy or used in the last `--min-age` minutes (default 60), and closes a run with nothing left after a day. Only what Sub5 made is touched: registered in a run, on a `sub5/` branch, named after a run id, or under `.claude/worktrees` with a run's snapshot base in its history. `--force` (dirty worktrees, unmerged branches) is for a person at a terminal; the plugin never passes it.
- `bin/delegate.py list [--dir DIR]... [--format text|json]`: the run folders of the last 3 days, newest first. Each run now keeps a private `meta.json` (target, start, and once it ends, the exit code and outcome; never the brief). Folders from before it still list, with what is unknown left null.
- **Delegate usage:** `delegate.py` now runs each CLI with JSON output (codex `--json`, the Cursor agent and agy `--output-format json`), takes the answer text back out of it, and keeps the token counts the CLI printed in `meta.json` (`input_tokens`, `output_tokens`, `cached_tokens`, and `cost_usd` only when a CLI reports one; none does today, and no price is estimated). A finished row and the records pane show them (`12.3k in · 1.1k out`), and the pane starts with a 3-day total per CLI.

### Changed

- Desktop app model buttons: the toast now says to press Enter in the prompt box and which effort level comes back after the switch. When the prompt box cannot take `/model <name>` (a dialog is open), the command goes to the clipboard, and the effort level is still put back once you send it. A one-click switch is still not possible there: Claude Code 2.1.292 refuses a plugin prompt that starts with `/`, the app refuses a session that sets its own model, and no plugin call moves the focus into the prompt box.

### Fixed

- `watch_deploy` with a bare target (`#128`, `run:123`, `sha:<commit>`) in a session that has no repo folder: gh could not read a repo and the watch failed every check. The watch now borrows the repo of the latest watch that named one, and the failure message says how to name it. A target may also name its repo: `owner/repo#128`, `owner/repo sha:<commit>`.
- Two watches started in the same millisecond shared an id, so one check could update the other.

## 1.0.0 — 2026-10-08

First public release, under the name **Deckhand**.

```text
/plugin marketplace add stephen-taipei/deckhand
/plugin install deckhand@deckhand
```

### Added

- **Recap** button: explains the current context plainly, with analogies, in a side pane. It does not add to the conversation.
- **`⚙` settings pane** at the right end of the band, in five tabs: General (language, visible buttons, usage warning), Delegates (one line per target; Edit opens its fields), Translate & search, Sub5, and Advanced (CLI paths and the Codex home folder, guards, deploy watch, reset with a confirm). Settings are stored per user.
- **Five display languages:** English, 繁體中文, 简体中文, 日本語 and 한국어. The language follows Claude Code's `language` setting by default.
- **Tooltips** on the band's buttons.
- **Editable delegate targets:** label, CLI, model ID, effort, name and on/off for each button. Buttons for CLIs that are not installed are hidden.
- Public marketplace entry, MIT license, READMEs in five languages with screenshots, a secret scan (`scripts/scan-secrets.py`) and CI.

### Changed

- Renamed from the personal `stephen-ops` mod to `deckhand`.
- Delegate buttons are labelled `cL` `cS` `cA` `cR` `gF`. A label keeps the case it is typed in, and `/delegate` matches it in any case.
- `agy_translate` is now `translate`. It is off by default; in settings you turn it on and pick which delegate (`cL` … `gF`) translates. It runs that delegate's CLI read-only through `bin/delegate.py --raw`.
- New **`search`** tool, off by default like `translate`: web research by the delegate you pick, answered with sources for Claude to check. `bin/delegate.py --web` turns on Codex's `web_search="live"` and Cursor agent's `--auto-review` (still in ask mode).
- Desktop app: a model button fills `/model <name>` into the prompt box, so the app's own model menu stays in sync. The terminal still switches the model directly and keeps the effort level.
- The attribution guard is off by default, unless your Claude settings already turn attribution off.
- The usage readout shows every per-model weekly window the account has (`fb` Fable, `sn` Sonnet, `op` Opus), not only Fable's.

## Before 1.0.0 — personal mod

Deckhand started in October 2026 as `stephen-ops`, a personal Claude Code mod that was not published. It was built to cut repeated deploy-status checks and manual copy-paste between Claude and Codex.

- Background PR, CI and URL watch (`/watch-deploy`, `watch_deploy`) that stops itself after repeated identical results, and Bash guards for blocking waits, repeated status checks and attribution trailers.
- Claude ↔ Codex handoff (`/handoff`, `/handoff-in`, the `/codex` inbox), with git facts filled in by a script instead of the model.
- The band above the prompt: usage gauges that match the app's usage card, `O` `F` `S` `H` model buttons, and Sub5 parallel workers in separate git worktrees.
- Read-only delegate buttons for Codex, Cursor agent and agy, with a secret check and private local records that are pruned after 3 days.
- `agy_translate` for localized translation.

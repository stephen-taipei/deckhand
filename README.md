<div align="center">

# Deckhand — the multi-AI toolbar for Claude Code

**Many hands, one deck.**

Usage gauges, one-click model switching, parallel sub agents and read-only second opinions from other AI CLIs, in one band above the Claude Code prompt.

[![Version](https://img.shields.io/badge/version-1.0.0-2563EB?style=flat-square)](plugins/deckhand/.claude-plugin/plugin.json)
[![Python](https://img.shields.io/badge/Python-%E2%89%A53.9-3C873A?style=flat-square)](#requirements)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?style=flat-square)](#install)
[![License](https://img.shields.io/badge/license-MIT-64748B?style=flat-square)](LICENSE)
[![CI](https://github.com/stephen-taipei/deckhand/actions/workflows/ci.yml/badge.svg)](https://github.com/stephen-taipei/deckhand/actions/workflows/ci.yml)

**English** · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

[Install](#install) · [The band](#the-band) · [Delegate buttons](#delegate-buttons) · [Settings](#settings) · [More tools](#more-tools) · [Privacy and safety](#privacy-and-safety) · [Sponsor](#sponsor) · [Changelog](CHANGELOG.md)

![The Deckhand band above the Claude Code prompt: two finished CI watches and their toast, usage gauges, model buttons, Sub5, delegate buttons, Recap and settings](docs/images/band.png)

<sub>Screenshots show the Traditional Chinese display language.</sub>

[Sponsor Deckhand with USDT (TRC20)](#sponsor) — one-time support only.

## What Deckhand does

Deckhand is a Claude Code plugin. It adds a band above the prompt, in the terminal and in the desktop app. Claude stays the main agent. From the band you can:

- see how much of each usage window is left;
- switch the model with one click;
- split a task across parallel sub agents in separate git worktrees;
- ask another AI CLI for a read-only second opinion, which Claude then reviews;
- get a plain-language recap of where the session stands.

## Install

Run these two commands in Claude Code:

```text
/plugin marketplace add stephen-taipei/deckhand
/plugin install deckhand@deckhand
```

The band appears above the prompt. If it does not, start a new session.

## The band

| Part | What it does |
| --- | --- |
| Usage gauges | 5-hour window, per-model weekly windows, weekly all-models window and context window |
| `O` `F` `S` `H` | Switch the model to Opus, Fable, Sonnet or Haiku |
| `Sub5` | Split the current task into up to 5 items and run them in parallel sub agents |
| `cL` `cS` `cA` `cR` `gF` | Hand one task to another AI CLI, read-only, and let Claude review the answer |
| `Recap` | Explain the current context plainly, with analogies, in a side pane |
| `⚙` | Open the settings pane (right end of the band) |

Hover a button to see what it does.

### Usage gauges

- `5h`: the 5-hour window.
- Per-model weekly windows that your account has, for example `fb` for Fable.
- `7d`: the weekly window across all models.
- `ctx`: how full the context window is.

The numbers match the usage card in the Claude app (rounded down). When a window crosses the warning threshold, Deckhand shows a toast once.

### Model buttons

`O` Opus · `F` Fable · `S` Sonnet · `H` Haiku

- **Terminal:** the button switches the session model directly and keeps your effort level.
- **Desktop app:** the app owns the session model there. The button fills `/model <name>` into the prompt box. You press Enter, and the app's own model menu stays in sync.

### Sub5

Sub5 splits the current task into up to 5 independent items. Each item runs in its own sub agent, in its own git worktree, at the same time. When the workers finish, the main agent reviews their work, integrates it, and cleans up the worktrees and branches.

A script (`bin/sub5.py`) runs the exact git steps. It never forces and never pushes. You can set the workers' model, effort and the maximum number of items in settings.

### Delegate buttons

A delegate button hands one task to another AI CLI. That AI works read-only and writes an answer. Claude reviews the answer and integrates what holds up.

| Button | CLI | Model | Effort |
| --- | --- | --- | --- |
| `cL` | Codex | GPT-6 Luna | max |
| `cS` | Codex | GPT-6.1 Sol | medium |
| `cA` | Codex | GPT-6 Astra | medium |
| `cR` | Cursor agent | Grok 4.7 | high |
| `gF` | agy | Gemini 3.8 Flash | high |

These are the defaults. In settings you can edit every target: label, CLI, model ID, effort, name, and on/off.

- **Read-only, per CLI:** Codex runs with `-s read-only`, Cursor agent with `--mode ask`, and agy runs headless, which denies tools automatically.
- **Web search (`search` only):** Codex gets `-c web_search="live"`, and Cursor agent gets `--auto-review` (still in ask mode) so that a search runs without asking. agy can already search in headless mode.
- **Secret check:** Deckhand refuses a brief that contains a token, key or password.
- **Local records:** the brief and the answer stay in a private temporary folder and are deleted after 3 days.
- **Progress in the band:** while a delegate runs, a row above the usage line shows its label, CLI, model and elapsed time. When it ends, the row shows the outcome for 10 minutes, or until you press **Clear finished**. There is no Stop button: Deckhand only watches the Bash call that runs the delegate.
- **Records:** the `/delegates` command, or **Records** on a finished row, lists the runs from the last 3 days. You can open each answer in full, copy it, or put it into the prompt box when the box is empty. Each run also shows the tokens its CLI counted, with a 3-day total per CLI at the top; Deckhand does not estimate prices, so a cost appears only if the CLI itself reports one (Codex, the Cursor agent and agy report none today).
- **Requirements:** the CLI must be installed and logged in. Buttons for CLIs that are not installed are hidden.

> [!NOTE]
> Delegating sends the brief to the provider behind that CLI.

### Recap

Recap explains the whole current context as plainly and briefly as possible, with analogies, in a side pane. It does not add anything to the conversation. The button reads `Recap` in every language.

### Settings

The `⚙` button at the right end of the band, or `/deckhand`, opens the settings pane. It has five tabs:

| Tab | What you set |
| --- | --- |
| General | Display language, which buttons show, the usage warning threshold |
| Delegates | Each delegate target: on/off, label, CLI, model ID, effort, name |
| Translate & search | Whether translation and web search go to a delegate, and which one (`cL` … `gF`). Both are off by default. |
| Sub5 | The workers' model, effort and maximum number of items |
| Advanced | CLI paths and the Codex home folder, the guards, the deploy watch, reset to defaults |

![Deckhand settings: the General tab and the Translate & search tab](docs/images/settings.png)

Settings are stored per user.

### Languages

English, 繁體中文, 简体中文, 日本語 and 한국어. By default the display language follows Claude Code's `language` setting. You can also pick a language in settings.

## More tools

| Tool | What it does |
| --- | --- |
| `/watch-deploy` and the `watch_deploy` tool | Watch a PR, a CI run or a URL in the background. The watch stops itself after N identical results in a row. |
| `/handoff`, `/handoff-in`, `/codex` | Hand work between Claude and Codex: write a handoff for Codex, bring Codex's latest handoff back into the prompt box, and open the Codex inbox. |
| Attribution guard | Strips `Co-Authored-By` trailers and the Claude Code footer from commit and PR commands. Off by default, unless your Claude settings already turn attribution off. |
| Polling guard | Stops `sleep` polling loops and blocking waits such as `gh run watch`, and stops a status check that returns the same result N times in a row. |
| `translate` | Localized translation by the delegate you pick in settings, in the wording native speakers use rather than word for word. Off by default: turn it on in `⚙`. |
| `search` | Web research by the delegate you pick in settings: a short answer, key points and the source of each, which Claude then checks. Off by default: turn it on in `⚙`. |

## Requirements

- macOS or Linux. Windows is not supported; WSL has not been tested.
- Claude Code with plugin hook modules (tested on 2.1.288).
- Python 3.9 or newer.
- Optional: `gh` for watches; the `codex`, Cursor `agent` and `agy` CLIs for the delegate buttons.

## Privacy and safety

What leaves your machine:

- **Delegate briefs** go to the provider of the CLI you chose, and only when you press a delegate button.
- **The usage readout** calls Anthropic's usage endpoint with the session's own credential, through Claude Code.
- **Tools that you or Claude call on purpose** reach the service they name: `translate` and `search`, once you turn them on, send their text to the delegate you picked, and a watch queries GitHub through `gh` or fetches the URL you gave it.

Nothing else leaves your machine.

Safety rules:

- Delegates are read-only, enforced by each CLI's own flag or mode.
- The secret check refuses briefs that contain tokens, keys or passwords.
- Briefs and answers are kept in a private temporary folder and pruned after 3 days.
- Sub5's git script never forces and never pushes.

## Development

```bash
(cd plugins/deckhand && python3 -m unittest discover -s tests -p 'test_*.py')
python3 -m unittest discover -s scripts -p 'test_*.py'
python3 scripts/scan-secrets.py
```

`scripts/scan-secrets.py` checks every tracked file for keys, tokens, credentials in URLs, email addresses and home-folder paths. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Sponsor

One-time USDT support helps maintain Deckhand's code, documentation and five-language localization. It does not buy membership, roadmap priority or support priority.

**USDT · TRON (TRC20)** · `TGuMUi1d8MoBQcuFrGJZnu4JrbaeP3wy9a`

<img src="docs/images/sponsor-usdt-trc20.png" alt="USDT (TRC20) QR: TGuMUi1d8MoBQcuFrGJZnu4JrbaeP3wy9a" width="160">

Send USDT on the TRON (TRC20) network only. Tokens sent on another network cannot be recovered.

## Contributing, security and license

[Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md) · [License](LICENSE)

Made and maintained by [stephen-taipei](https://github.com/stephen-taipei). Deckhand is an independent plugin and is not an Anthropic product. Released under the [MIT License](LICENSE).

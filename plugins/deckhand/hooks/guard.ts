/**
 * Pure helpers for the Bash guards: attribution stripping, blocking waits and
 * the 3-strike rule for repeated status checks. Kept free of `$` so tests can
 * call them.
 */
import { outputSignature } from './fingerprint'
import type { Messages } from './i18n'

const ATTRIBUTION = [
  /Co-Authored-By:[^\n"'`]*/gi,
  /🤖\s*Generated with \[Claude Code\]\([^)\n]*\)/g,
  /Generated with \[Claude Code\]\([^)\n]*\)/g,
]

const WRITES_MESSAGE = /\bgit\b[^\n|;&]*\bcommit\b|\bgh\s+pr\s+(create|edit)\b|\bgit\b[^\n|;&]*\btag\b\s+-[am]/

/** Removes Co-Authored-By trailers and the Claude Code PR footer from a commit / PR command. */
export const stripAttribution = (command: string): string | null => {
  if (!WRITES_MESSAGE.test(command)) return null
  const kept: string[] = []
  let isChanged = false
  for (const line of command.split('\n')) {
    let next = line
    for (const pattern of ATTRIBUTION) next = next.replace(pattern, '')
    if (next === line) {
      kept.push(line)
      continue
    }
    isChanged = true
    const isLeading = /^\s*(Co-Authored-By:|🤖|Generated with)/i.test(line)
    if (next.trim() !== '' && !isLeading) {
      kept.push(next)
      continue
    }
    // The line opened with the trailer: drop it and the blank lines that set it
    // apart, and hand what closed the message (a quote, a paren) to the line before.
    while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop()
    const rest = next.trim()
    if (rest === '') continue
    if (kept.length > 0) kept[kept.length - 1] += rest
    else kept.push(rest)
  }
  return isChanged ? kept.join('\n') : null
}

// ── what a command line runs ───────────────────────────────────────────────

/** A command whose quoted argument or heredoc is itself run: `bash -c '…'`, `ssh host '…'`, `eval "…"`. */
const RUNS_TEXT = /(?:^|[\s|;&(!])(?:\S*\/)?(?:(?:ba|z|da|k)?sh|ssh|eval|watch)(?:\s|$)/

/** The command being written when the scan reaches this point: the text since the last `|`, `;`, `&`, `(` or line break. */
const segmentOf = (before: string) => before.slice(Math.max(...['|', ';', '&', '(', '\n'].map(c => before.lastIndexOf(c))) + 1)

/** Data in quotes becomes one opaque word: `"gh run watch"` → `gh_run_watch`, so no guard pattern sees a command in it, while a quoted URL stays a URL. */
const opaque = (text: string) => text.replace(/[^\w:/.@~%+=,-]/g, '_')

/** In double quotes, `$(…)` and backticks still run: keep them, the rest is data. */
const keepSubstitutions = (text: string) =>
  [...text.matchAll(/\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`/g)].map(s => ` ${s[1] ?? s[2]} `).join('') || opaque(text)

/** A heredoc start, `<<EOF`, `<<-'EOF'`, never a here-string (`<<<`). */
const HEREDOC = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g

/**
 * The part of a command line the shell runs, as the guards read it: heredoc bodies and quoted
 * strings are data (a script fed to `python3 -`, a commit message, a `grep` pattern) unless the
 * command they belong to runs them. So writing about `gh run watch` is never mistaken for running it.
 */
export const executable = (command: string): string => {
  const lines = command.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    kept.push(line)
    for (const tag of line.matchAll(HEREDOC)) {
      const isRun = RUNS_TEXT.test(segmentOf(line.slice(0, tag.index)))
      for (i++; i < lines.length && lines[i]!.trim() !== tag[2]; i++) if (isRun) kept.push(lines[i]!)
    }
  }
  const text = kept.join('\n')
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '\\') {
      out += text.slice(i, i + 2)
      i++
    } else if (c === "'" || c === '"') {
      let end = i + 1
      while (end < text.length && text[end] !== c) end += c === '"' && text[end] === '\\' ? 2 : 1
      const body = text.slice(i + 1, end)
      out += RUNS_TEXT.test(segmentOf(out)) ? ` ${body} ` : c === '"' ? keepSubstitutions(body) : opaque(body)
      i = end
    } else out += c
  }
  return out
}

/** Long blocking waits the watch tool replaces. Quoted text and heredocs are data, not waits. */
export const blockingWait = (raw: string, m: Messages): string | null => {
  const command = executable(raw)
  if (/\bgh\s+run\s+watch\b/.test(command)) return 'gh run watch'
  if (/\bgh\s+pr\s+checks\b[^\n]*--watch\b/.test(command)) return 'gh pr checks --watch'
  // A loop that sleeps and calls a status tool, in whichever order the words come.
  if (/\b(?:until|while)\b/.test(command) && /\bsleep\b/.test(command) && /\b(?:gh|curl|wget|ssh)\b/.test(command)) {
    return m.guard.loop
  }
  const sleep = command.match(/\bsleep\s+(\d+)/)
  if (sleep && Number(sleep[1]) >= 20 && /\b(gh|curl|wget|ssh)\b/.test(command)) return m.guard.sleepPoll(sleep[1]!)
  return null
}

// ── repeated status checks ─────────────────────────────────────────────────

/** Parts of a command line that wait or print, not check: they change between tries, the check does not. */
const FILLER = /^(?:sleep\s+[\d.]+[smhd]?|echo\b.*|printf\b.*|date\b.*|true|:)$/

const STATUS_CHECK = new RegExp(
  [
    String.raw`\bgh\s+pr\s+(?:view|checks|status)\b`,
    String.raw`\bgh\s+run\s+(?:list|view)\b`,
    String.raw`\bgh\s+api\b[^\n|]*\/(?:actions\/runs|deployments|check-runs|status|pulls\/\d+)`,
    String.raw`\bcurl\b[^\n]*(?:https?:\/\/|localhost)`,
    String.raw`\bgit\s+(?:fetch|ls-remote)\b`,
    String.raw`\bssh\b[^\n]*\b(?:cat|ls|readlink|stat|tail|head|systemctl\s+status|docker\s+(?:ps|logs)|journalctl)\b`,
  ].join('|'),
)

const WRITES =
  /\b(?:git\s+(?:push|commit|merge|pull|rebase|reset|checkout|switch)|gh\s+pr\s+(?:merge|create|edit|close)|rsync|scp|deploy)\b/

/** A request that changes something is no status check, however often it is repeated. */
const isMutating = (command: string) =>
  /\bgh\s+api\b/.test(command)
    ? /(?:^|\s)(?:-X|--method|-f|-F|--field|--raw-field|--input)(?=[\s=]|$)/.test(command)
    : /(?:^|\s)(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request[=\s]+(?:POST|PUT|PATCH|DELETE)|-d|--data\S*|-F|--form\S*|-T|--upload-file)(?=[\s=]|$)/.test(command)

/**
 * A stable key for "the same check": the status-style part of the command, without
 * the sleeps, echoes, `2>&1` and `| tail` a model varies from try to try.
 */
export const statusKey = (command: string): string | null => {
  const key = executable(command)
    .split(/&&|\|\||;|\n/)
    .map(part => part.trim())
    .filter(part => part !== '' && !FILLER.test(part))
    .join(' && ')
    .replace(/\s*2>&1/g, '')
    .replace(/\s*\|\s*(?:tail|head)\b[^|]*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!key || !STATUS_CHECK.test(key) || WRITES.test(key) || isMutating(key)) return null
  return key.slice(0, 400)
}

/** What counts as "the same result": JSON by meaning, text by its distinct lines, noise masked. */
export const normalizeOutput = outputSignature

export type Strike = { output: string; count: number }

/** Counts consecutive identical results per check; a changed result starts over at 1. */
export const recordStrike = (strikes: Map<string, Strike>, key: string, output: string): number => {
  const prior = strikes.get(key)
  const count = prior && prior.output === output ? prior.count + 1 : 1
  strikes.set(key, { output, count })
  return count
}

/**
 * Delegate runs as the band and the records pane see them: which Bash call is a `delegate.py run`,
 * what its output and its background task's notification say, and the run folders `delegate.py list`
 * reports. Kept free of `$` so tests can read it. The brief (the heredoc) is never read.
 */
import type { DelegateRecord, DelegateRun, DelegateTool } from '../types'
import { TOOL_NAME } from './delegate'
import type { Messages } from './i18n'

/** delegate.py's own default --timeout, in minutes. */
export const DEFAULT_TIMEOUT_MIN = 30

const TOOLS: readonly DelegateTool[] = ['codex', 'agent', 'agy']

/** The shell words of one line, quotes undone, up to a heredoc, a pipe, a redirect or a separator. */
const words = (text: string): string[] => {
  const out: string[] = []
  let word = ''
  let quote = ''
  let isWord = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!
    if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      isWord = true
    } else if (c === '\\' && i + 1 < text.length) {
      word += text[++i]
      isWord = true
    } else if (/\s/.test(c)) {
      if (isWord) out.push(word)
      word = ''
      isWord = false
    } else if (';&|<>'.includes(c)) {
      if (isWord) out.push(word)
      return out
    } else {
      word += c
      isWord = true
    }
  }
  if (isWord) out.push(word)
  return out
}

export type DelegateCall = { label: string; tool?: DelegateTool; name?: string; timeoutMin: number }

/**
 * The flags of the first `delegate.py run` in a Bash command, or null when there is none (a dry run
 * runs nothing, so it is none). Only the command line up to the heredoc is read, never the brief.
 */
export const parseDelegateCall = (command: string): DelegateCall | null => {
  const found = command.match(/delegate\.py['"]?[ \t]+run(?=[\s;&|<]|$)/)
  if (!found) return null
  const rest = command.slice(found.index! + found[0].length).replace(/\\\r?\n/g, ' ').split('\n')[0]!
  const flags = words(rest)
  if (flags.includes('--dry-run')) return null
  const flag = (name: string) => {
    for (let i = 0; i < flags.length; i += 1) {
      if (flags[i] === name) return flags[i + 1]
      if (flags[i]!.startsWith(`${name}=`)) return flags[i]!.slice(name.length + 1)
    }
    return undefined
  }
  const tool = TOOLS.find(t => t === flag('--tool'))
  const label = (flag('--label') ?? tool ?? 'delegate').slice(0, 12)
  const name = flag('--name')?.trim().slice(0, 40) || flag('--model')?.slice(0, 40) || undefined
  const timeout = Number(flag('--timeout'))
  return { label, tool, name, timeoutMin: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MIN }
}

/** A run folder's answer file, in any of the languages delegate.py prints. */
const ANSWER_PATH = /(\/\S*?\/\d{8}-\d{6}-[A-Za-z0-9]{1,6}-[0-9a-f]{4}\/answer\.md)/

/**
 * What a `delegate.py run`'s output says: the seconds on its `[delegate] … · N s · outcome` line (the
 * unit is the language's: s, 秒, 초) and the answer file's path.
 */
export const parseDelegateOutput = (text: string): { seconds?: number; answerPath?: string } => {
  const header = text.split('\n').find(line => line.startsWith('[delegate] ')) ?? ''
  const seconds = header.match(/·\s*(\d+(?:\.\d+)?)\s*(?:s|秒|초)\s*·/)
  const path = text.match(ANSWER_PATH)
  return {
    ...(seconds ? { seconds: Number(seconds[1]) } : {}),
    ...(path ? { answerPath: path[1] } : {}),
  }
}

/** The exit code an errored Bash result reports (`Exit code 5`), when it does. */
export const exitCodeOf = (text: string): number | undefined => {
  const m = text.match(/^Exit code (\d+)/m)
  return m ? Number(m[1]) : undefined
}

export type TaskEnded = { taskId?: string; toolUseId?: string; status?: string; exitCode?: number; outputFile?: string }

/** A background task's notification, as the engine words it; null for any other prompt. */
export const parseTaskNotification = (text: string): TaskEnded | null => {
  if (!text.includes('<task-notification>')) return null
  const tag = (name: string) => text.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]?.trim() || undefined
  const code = (tag('summary') ?? '').match(/exit code (\d+)/i)
  return {
    taskId: tag('task-id'),
    toolUseId: tag('tool-use-id'),
    status: tag('status'),
    exitCode: code ? Number(code[1]) : undefined,
    outputFile: tag('output-file'),
  }
}

/** `1:05`, `12:40`, `1:02:03`. */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(s / 60) % 60)
  const ss = String(s % 60).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

/** `Codex · GPT-6 Luna`, or what is known of it. */
export const whoOf = (tool: DelegateTool | null | undefined, name: string | null | undefined, m: Messages) =>
  tool ? `${TOOL_NAME[tool]} · ${name || '?'}` : name || m.delegate.notRecorded

/** What a finished run's exit code means, in the catalog's words. */
export const outcomeOf = (code: number | null | undefined, m: Messages) => (code === 0 ? m.delegate.answered : m.delegate.exitWord(code ?? null))

/** The band's words for one run: the mark, and the line after the label. */
export const runLine = (r: DelegateRun, now: number, m: Messages): { mark: string; text: string } => {
  if (r.status === 'running') {
    const parts = [...(r.tool ? [TOOL_NAME[r.tool]] : []), ...(r.name ? [r.name] : []), clock(now - r.startedAt)]
    return { mark: '⏳', text: parts.join(' · ') + (r.taskId ? ` · ${m.delegate.inBackground}` : '') }
  }
  if (r.status === 'answered') {
    const ms = r.seconds !== undefined ? r.seconds * 1000 : (r.finishedAt ?? now) - r.startedAt
    return { mark: '✅', text: `${clock(ms)} · ${m.delegate.answered}` }
  }
  if (r.status === 'failed') return { mark: '❌', text: outcomeOf(r.exitCode, m) }
  if (r.status === 'stopped') return { mark: '⏹', text: m.delegate.interrupted }
  return { mark: '⚠', text: m.delegate.lost }
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** `delegate.py list --format json`'s answer, checked; throws when it is no list. */
export const parseRecords = (stdout: string): DelegateRecord[] => {
  const raw = JSON.parse(stdout) as unknown
  if (!Array.isArray(raw)) throw new Error('delegate.py list did not answer a list')
  return raw.flatMap((x): DelegateRecord[] => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    const id = str(o.id)
    const path = str(o.path)
    if (!id || !path) return []
    return [
      {
        id,
        path,
        label: str(o.label) ?? '?',
        started: num(o.started),
        tool: TOOLS.find(t => t === o.tool) ?? null,
        model: str(o.model),
        name: str(o.name),
        seconds: num(o.seconds),
        exit: num(o.exit),
        answerPath: str(o.answer_path),
        answerBytes: num(o.answer_bytes),
        hasStderr: o.has_stderr === true,
        firstLine: str(o.first_line) ?? '',
      },
    ]
  })
}

/**
 * The run folder a run in flight is, among the listed ones: its own once matched, else the earliest
 * one of its label started at or after it (a few seconds' leeway) that no other run has claimed.
 */
export const matchRecord = (run: DelegateRun, records: readonly DelegateRecord[], claimed: ReadonlySet<string>) => {
  if (run.folder) return records.find(r => r.path === run.folder)
  return records
    .filter(r => r.label === run.label && r.started !== null && r.started * 1000 >= run.startedAt - 5_000 && !claimed.has(r.path))
    .sort((a, b) => a.started! - b.started!)[0]
}

/** Answers longer than this go into the prompt box as a reference to their file. */
export const PASTE_MAX_CHARS = 20_000

/** What "into the prompt box" writes for an answer: the answer itself, or where to read it. */
export const pasteAnswer = (o: { label: string; who: string; path: string; text: string }, m: Messages) =>
  o.text.length <= PASTE_MAX_CHARS ? m.delegate.paste(o.label, o.who, o.path, o.text.trim()) : m.delegate.pasteRef(o.label, o.who, o.path)

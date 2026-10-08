/**
 * Pure helpers for the Claude ↔ Codex handoff and the Codex inbox. The handoff
 * file itself (folder, file name, git facts, secret masking, comparison with the
 * repo) is made by bin/handoff-state.py, which Codex runs too; this file only
 * words the narrative request and reads the tool's answers.
 */
import type { CodexThread } from '../types'
import type { Messages } from './i18n'

/** Models like to wrap a whole document in a ```markdown fence; the file should hold the document. */
export const unfence = (text: string) => {
  const m = text.trim().match(/^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/i)
  return (m ? m[1]! : text).trim()
}

// ── answers of bin/handoff-state.py ────────────────────────────────────────

export type HandoffWritten = {
  path: string
  latest: string
  project: string
  /** Secrets the tool masked in the narrative. */
  redacted: number
  state: Record<string, string | number>
  nextPrompt: string
}

export type HandoffChecked = {
  path: string
  age: string
  differences: number
  report: string
  nextPrompt: string
}

/** `check` found no usable file: `missing`, or `no-front-matter` (a file this tool did not write). */
export type HandoffMissing = { error: string; path: string }

const objectOf = (stdout: string): Record<string, unknown> | null => {
  const lines = stdout.trim().split('\n')
  for (const candidate of [stdout.trim(), lines[lines.length - 1] ?? '']) {
    try {
      const value: unknown = JSON.parse(candidate)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      // Try the last line, then give up.
    }
  }
  return null
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

export const parseWritten = (stdout: string): HandoffWritten | null => {
  const o = objectOf(stdout)
  if (!o || !text(o.path) || !text(o.next_prompt)) return null
  const state = typeof o.state === 'object' && o.state !== null ? (o.state as Record<string, string | number>) : {}
  return {
    path: text(o.path),
    latest: text(o.latest),
    project: text(o.project),
    redacted: typeof o.redacted === 'number' ? o.redacted : 0,
    state,
    nextPrompt: text(o.next_prompt),
  }
}

export const parseChecked = (stdout: string): HandoffChecked | HandoffMissing | null => {
  const o = objectOf(stdout)
  if (!o) return null
  if (text(o.error)) return { error: text(o.error), path: text(o.path) }
  if (!text(o.path) || !text(o.next_prompt)) return null
  return {
    path: text(o.path),
    age: text(o.age),
    differences: typeof o.differences === 'number' ? o.differences : 0,
    report: text(o.report),
    nextPrompt: text(o.next_prompt),
  }
}

/** One line of what the tool recorded: `project x · main @ abc1234 · uncommitted 2 · PR #7 OPEN`. */
export const stateLine = (state: Record<string, string | number>, m: Messages) => {
  const parts = [m.codex.project(String(state.project ?? '?'))]
  if (state.branch) parts.push(`${state.branch}${state.head ? ` @ ${String(state.head).slice(0, 7)}` : ''}`)
  if (state.dirty_files !== undefined) parts.push(m.codex.uncommitted(state.dirty_files, state.untracked_files ? m.codex.untracked(state.untracked_files) : ''))
  if (state.pr_number) parts.push(`PR #${state.pr_number}${state.pr_state ? ` ${state.pr_state}` : ''}`)
  return parts.join(' · ')
}

// ── Codex inbox ────────────────────────────────────────────────────────────

export const pastePrompt = (t: CodexThread, m: Messages) => m.codex.paste(t.name, t.cwd, t.lastAssistant)

export const ago = (ms: number, now: number, m: Messages) => {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000))
  if (minutes < 60) return m.codex.minutesAgo(minutes)
  const hours = Math.round(minutes / 60)
  return hours < 48 ? m.codex.hoursAgo(hours) : m.codex.daysAgo(Math.round(hours / 24))
}

export const threadsArgv = (pluginRoot: string, root: string, isAll: boolean, codexHome = '') => [
  'python3',
  `${pluginRoot}/bin/codex-threads.py`,
  ...(codexHome ? ['--codex-home', codexHome] : []),
  '--days',
  '7',
  '--limit',
  '12',
  ...(isAll ? [] : ['--cwd', root]),
]

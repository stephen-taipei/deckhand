/**
 * The Sub5 flow, as words: what the main agent is told when the Sub5 button is pressed (the brief is
 * in the catalogs, one per language), and the worker agent type it dispatches. The exact git parts
 * (base snapshot, applying, checking, cleaning) are bin/sub5.py's; the judgment (what to split, how to
 * rank, whether a result meets the bar) is the main agent's. Kept free of `$` so tests can read it.
 */
import type { Sub5KeepReason, Sub5Leftover } from '../types'
import { ago } from './codex'
import type { Locale, Messages } from './i18n'
import { shq } from './shell'

export const SUB5_AGENT = 'deckhand:sub5-worker'

export type Sub5Options = {
  /** At most this many items are dispatched at once. */
  max: number
  /** The workers' model and effort, as the agent type carries them. */
  model: string
  effort: string
  /** Absolute path of bin/sub5.py. */
  tool: string
  note?: string
  locale: Locale
  attribution: boolean
}

/** The prefix every sub5.py command of the brief starts with: the tool speaks the brief's language. */
export const sub5Run = (tool: string, locale: Locale) => `DECKHAND_LANG=${locale} python3 ${shq(tool)}`

export const sub5Prompt = (o: Sub5Options, m: Messages): string =>
  m.sub5.brief({
    max: o.max,
    model: o.model,
    effort: o.effort,
    run: sub5Run(o.tool, o.locale),
    note: o.note,
    languageName: m.languageName,
    attribution: o.attribution,
  })

export const WORKER_DESCRIPTION =
  'Parallel worker of the Sub5 flow: dispatched only by the main agent while it runs Sub5 (the user pressed the Sub5 button), to finish one assigned item in its own worktree. Not for ordinary delegation.'

export const workerPrompt = (languageName: string, attribution: boolean) =>
  [
    'You are a Sub5 worker, one of up to five parallel workers the main agent dispatched at once. You work in your own git worktree (the current directory). The assignment gives you RUN, ITEM, BASE (a commit SHA), the goal, the files you may change, the acceptance criteria and the verification commands.',
    '',
    'Rules',
    "1. Work only in your own worktree (the current directory). Do not read, write or operate on the main working tree, other worktrees or any remote; no push, no PR, no git config changes, never delete a branch or worktree (cleanup is the main agent's job).",
    '2. First step, never skipped: align the worktree to BASE.',
    '   BR=$(git branch --show-current); [ -n "$BR" ] || BR="sub5/<RUN>/<ITEM>"; git checkout -B "$BR" <BASE>',
    '   The worktree is new, so this is safe. Then check `git rev-parse HEAD` equals BASE; if not, stop and report RESULT: blocked.',
    "3. Do only the assigned item and change only the allowed files. If a file outside them must change, don't change it: explain why and what you suggest under NEEDS.",
    "4. Verify yourself: run the given verification commands; without any, the project's usual tests, type check, lint or build that cover your change. Record the results honestly. Fix failures until they pass; if you can't, say so, never claim a pass.",
    `5. Commit all changes on your branch (several commits are fine, project conventions${attribution ? ', no Co-Authored-By trailer and no "Generated with Claude Code" footer' : ''}). Before reporting, \`git status --porcelain\` must be empty.`,
    '6. Leave nothing behind: no files outside the worktree; temporary files go in `.sub5-tmp/` inside the worktree and are deleted before reporting, never committed; no background processes (dev servers, watchers): stop any you started and note it under NOTES.',
    '7. Never loosen a test, skip a check or change the acceptance criteria to make verification pass; put doubts under NEEDS.',
    '',
    `Report format (fixed field names; values in ${languageName})`,
    'RESULT: ready | blocked',
    'BRANCH: <git branch --show-current>',
    'WORKTREE: <pwd>',
    'HEAD: <git rev-parse HEAD>',
    'BASE: <the BASE you were given>',
    'FILES: <summary of git diff --stat BASE..HEAD>',
    'VERIFIED: <commands run and results>',
    'NOT_VERIFIED: <what was not verified and why; "none" if nothing>',
    'NEEDS: <what the main agent must decide or handle; "none" if nothing>',
    'NOTES: <for the integrator: risks, possible interactions with other items>',
    '',
    'When the main agent sends review comments: handle them point by point, verify again, commit again, and report again in the same format (decide RESULT afresh).',
  ].join('\n')

// ── Leftovers of interrupted runs: `sub5.py list` and `clean` ──

/**
 * The argv of `sub5.py list|clean --format json` in the session's folder. Never `--force`: Sub5 cleanup
 * never forces, so a dirty worktree or an unmerged branch stays for the person to deal with.
 */
export const leftoversArgv = (o: { python: string; tool: string; action: 'list' | 'clean'; cwd: string; locale: Locale }) => [
  o.python,
  o.tool,
  o.action,
  '--format',
  'json',
  '--cwd',
  o.cwd,
  '--lang',
  o.locale,
]

const KEEP_REASONS: readonly Sub5KeepReason[] = ['dirty', 'unmerged', 'recent', 'locked', 'current', 'busy']
const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null)
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** The leftovers in `sub5.py list --format json`; null when the output is not that. */
export const parseLeftovers = (stdout: string): Sub5Leftover[] | null => {
  const o = rec(parseJson(stdout))
  if (!Array.isArray(o.entries)) return null
  return o.entries.map(raw => {
    const e = rec(raw)
    return {
      path: strOrNull(e.path),
      branch: strOrNull(e.branch),
      run: strOrNull(e.run),
      worktreeExists: e.worktree_exists === true,
      merged: e.merged === true,
      dirty: numOrNull(e.dirty),
      ageSeconds: numOrNull(e.age_seconds),
      removeWorktree: e.remove_worktree === true,
      deleteBranch: e.delete_branch === true,
      keep: (Array.isArray(e.keep) ? e.keep : []).filter((r): r is Sub5KeepReason => KEEP_REASONS.includes(r as Sub5KeepReason)),
    }
  })
}

/** What `sub5.py clean --format json` did, counted; null when the output is not that. */
export const parseCleaned = (stdout: string): { worktrees: number; branches: number; kept: number; failed: number } | null => {
  const o = rec(parseJson(stdout))
  const count = (v: unknown) => (Array.isArray(v) ? v.length : -1)
  const c = { worktrees: count(o.removed_worktrees), branches: count(o.deleted_branches), kept: count(o.kept), failed: count(o.failed) }
  return Object.values(c).some(n => n < 0) ? null : c
}

/** A leftover clean would act on: its worktree goes, its branch goes, or both. */
export const isActionable = (e: Sub5Leftover) => e.removeWorktree || e.deleteBranch

/** The line under a leftover in the pane: branch, age, merged or not, and what clean does with it. */
export const leftoverLine = (e: Sub5Leftover, m: Messages) => {
  const parts = [e.branch ?? m.sub5.cleanNoBranch]
  if (e.ageSeconds !== null) parts.push(ago(0, e.ageSeconds * 1000, m))
  parts.push(e.merged ? m.sub5.cleanMerged : m.sub5.cleanUnmerged)
  if (e.path && !e.worktreeExists) parts.push(m.sub5.cleanGone)
  if (e.dirty) parts.push(m.sub5.cleanDirty(e.dirty))
  if (!e.keep.length) parts.push(m.sub5.cleanWillRemove)
  else {
    if (e.removeWorktree) parts.push(m.sub5.cleanWorktreeOnly)
    parts.push(m.sub5.cleanKept(e.keep.map(r => m.sub5.reasons[r]).join(m.listSep)))
  }
  return parts.join(' · ')
}

/** The agent type the Sub5 brief dispatches: the workers' model and effort are the person's to set. */
export const workerSpec = (o: { model: string; effort: string; languageName: string; attribution: boolean }) => ({
  name: 'sub5-worker',
  description: WORKER_DESCRIPTION,
  prompt: workerPrompt(o.languageName, o.attribution),
  model: o.model,
  effort: o.effort,
  isolation: 'worktree' as const,
  background: true as const,
  // A worker neither fans out further nor moves between worktrees.
  disallowedTools: ['Agent', 'EnterWorktree', 'ExitWorktree'],
})

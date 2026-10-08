/**
 * Pure logic of the deploy watch: target parsing, turning gh / HTTP answers
 * into a signature and summary, and the stop rules (identical results, stall
 * time, flapping pages, a ceiling) with their backoff. The engine calls live
 * in register.tsx.
 */
import { changingParts } from './fingerprint'
import type { Messages } from './i18n'
import type { Watch, WatchKind } from '../types'

export type WatchSettings = {
  /** First interval between checks. */
  baseMs: number
  /** Identical results in a row that make a watch a candidate for stopping. */
  limit: number
  /** ...and the watch stops only once its status has also stood still this long (0: the count alone). */
  stallMs: number
}

/**
 * `followUp`: a target to watch next once this one is done (a merged PR's CI).
 * `baseline`: what a URL watch compares later pages with. `stop`: ends the watch at once, with its reason.
 */
export type CheckResult = {
  signature: string
  summary: string
  isDone: boolean
  followUp?: string
  baseline?: string
  stop?: string
}

export type Target = { kind: WatchKind; target: string; repo?: string }

/** Reads `#128`, `128`, `pr:128`, `run:123`, `sha:<commit>`, a GitHub PR / run URL, or any http(s) URL. */
export const parseTarget = (raw: string): Target | null => {
  const text = raw.trim()
  const pr = text.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/)
  if (pr) return { kind: 'pr', target: pr[2]!, repo: pr[1]! }
  const run = text.match(/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)/)
  if (run) return { kind: 'run', target: run[2]!, repo: run[1]! }
  if (/^https?:\/\//.test(text)) return { kind: 'url', target: text }
  const prNumber = text.match(/^(?:pr[:#\s]*)?#?(\d+)$/i)
  if (prNumber) return { kind: 'pr', target: prNumber[1]! }
  const runId = text.match(/^run[:#\s]*(\d+)$/i)
  if (runId) return { kind: 'run', target: runId[1]! }
  const sha = text.match(/^(?:sha|commit)[:\s]*([0-9a-f]{7,40})$/i)
  if (sha) return { kind: 'run', target: `sha:${sha[1]!}` }
  return null
}

export const labelOf = (t: Target) =>
  t.kind === 'pr'
    ? `PR #${t.target}`
    : t.kind === 'run'
      ? t.target.startsWith('sha:')
        ? `CI @${t.target.slice(4, 11)}`
        : `Run ${t.target}`
      : t.target.replace(/^https?:\/\//, '').slice(0, 48)

/** The gh argv (without `gh` and `--repo`) for one check of a PR or run watch. */
export const ghArgs = (w: Pick<Watch, 'kind' | 'target'>): string[] =>
  w.kind === 'pr'
    ? ['pr', 'view', w.target, '--json', 'number,title,state,mergeStateStatus,statusCheckRollup,mergeCommit']
    : w.target.startsWith('sha:')
      ? ['run', 'list', '--commit', w.target.slice(4), '--limit', '30', '--json', 'status,conclusion,workflowName']
      : ['run', 'view', w.target, '--json', 'status,conclusion,workflowName']

type CheckItem = { status?: string; conclusion?: string; state?: string }

export const tally = (items: readonly CheckItem[]) => {
  let pass = 0
  let fail = 0
  let pending = 0
  for (const item of items) {
    const verdict = (item.conclusion || item.state || '').toUpperCase()
    const isComplete = item.status
      ? item.status.toUpperCase() === 'COMPLETED'
      : verdict !== '' && verdict !== 'PENDING' && verdict !== 'EXPECTED'
    if (!isComplete) pending += 1
    else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(verdict)) pass += 1
    else fail += 1
  }
  return { pass, fail, pending }
}

export type PrView = {
  state: string
  mergeStateStatus: string
  statusCheckRollup: CheckItem[] | null
  mergeCommit: { oid: string } | null
}

export const prResult = (pr: PrView, m: Messages): CheckResult => {
  const { pass, fail, pending } = tally(pr.statusCheckRollup ?? [])
  const checks = pass + fail + pending > 0 ? `checks ✓${pass} ✗${fail} …${pending}` : 'no checks'
  const isMerged = pr.state === 'MERGED'
  const merge = isMerged && pr.mergeCommit ? m.watch.merged(pr.mergeCommit.oid.slice(0, 7)) : ''
  return {
    signature: `${pr.state}|${pr.mergeStateStatus}|${pass}/${fail}/${pending}`,
    summary: `${pr.state} · ${checks} · ${pr.mergeStateStatus}${merge}`,
    isDone: isMerged || pr.state === 'CLOSED' || (pending === 0 && fail > 0),
    followUp: isMerged && pr.mergeCommit ? `sha:${pr.mergeCommit.oid}` : undefined,
  }
}

export type RunItem = { status: string; conclusion: string; workflowName?: string }

export const runResult = (runs: readonly RunItem[], m: Messages): CheckResult => {
  if (runs.length === 0) return { signature: 'none', summary: m.watch.noRuns, isDone: false }
  const done = runs.filter(r => r.status.toLowerCase() === 'completed')
  const failed = done.filter(r => !['success', 'skipped', 'neutral'].includes(r.conclusion.toLowerCase()))
  const states = runs.map(r => `${r.workflowName ?? 'run'}:${r.status === 'completed' ? r.conclusion : r.status}`)
  return {
    signature: [...states].sort().join(','),
    summary: m.watch.runs(done.length, runs.length, failed.map(r => r.workflowName ?? 'run').join(', '), done.length === runs.length),
    isDone: done.length === runs.length,
  }
}

// ── URL watch ──────────────────────────────────────────────────────────────

/** Checks in a row that all differ from the one before: no deploy looks like that. */
const FLAPPING_RUN = 6

const shortPrint = (fingerprint: string) => fingerprint.replace(/^[a-z]+:/, '').slice(0, 8)

/**
 * One check of a URL. With `expect`, done when that text shows up on a healthy page. Without it,
 * done when the page's fingerprint (see fingerprint.ts) differs from the first healthy one and the
 * next check sees the same new fingerprint: one odd response from one node is not a deploy. A page
 * whose fingerprint differs on every check has random content, and no answer can be read from it.
 */
export const urlResult = (
  w: Pick<Watch, 'expect' | 'baseline' | 'signature' | 'seen'>,
  status: number,
  fingerprint: string,
  body: string,
  m: Messages,
): CheckResult => {
  const isUp = status >= 200 && status < 400
  if (w.expect) {
    const isLive = isUp && body.includes(w.expect)
    return {
      signature: `${status}|${isLive ? 'live' : 'waiting'}`,
      summary: m.watch.expect(status, isLive, w.expect),
      isDone: isLive,
    }
  }
  if (!isUp) return { signature: `http-${status}`, summary: m.watch.down(status), isDone: false }

  const signature = `${status}|${fingerprint}`
  const baseline = w.baseline ?? signature
  const recent = [...(w.seen ?? []), signature].slice(-FLAPPING_RUN)
  if (recent.length === FLAPPING_RUN && recent.every((s, i) => i === 0 || s !== recent[i - 1])) {
    const parts = changingParts(recent).map(p => m.watch.parts[p] ?? p)
    return {
      signature,
      baseline,
      isDone: false,
      summary: m.watch.flapping(status),
      stop: m.watch.flappingStop(parts.join(m.listSep)),
    }
  }
  if (signature === baseline) {
    return { signature, baseline, isDone: false, summary: m.watch.same(status, shortPrint(fingerprint)) }
  }
  const isConfirmed = w.signature === signature
  return {
    signature,
    baseline,
    isDone: isConfirmed,
    summary: isConfirmed
      ? m.watch.confirmed(status, shortPrint(fingerprint))
      : m.watch.changed(status),
  }
}

export const errorResult = (message: string, m: Messages): CheckResult => ({
  signature: `error:${message}`,
  summary: m.watch.checkFailed(message),
  isDone: false,
})

// ── stopping ───────────────────────────────────────────────────────────────

/** A watch that has never finished is stopped here whatever else happens. */
export const MAX_CHECKS = 120
const MAX_INTERVAL_MS = 300_000

/**
 * Applies one check result to a watch. A watch stops when it is done, when the page says so
 * (`stop`), when `limit` identical results in a row have also stood still for `stallMs`, or at
 * MAX_CHECKS. The stall time keeps a long single CI step from looking like a hang; the count
 * keeps a PR nobody is reviewing from being watched forever.
 */
export const advance = (w: Watch, r: CheckResult, now: number, s: WatchSettings, m: Messages): Watch => {
  const isSame = w.checks > 0 && r.signature === w.signature
  const unchanged = isSame ? w.unchanged + 1 : 0
  const changedAt = isSame ? (w.changedAt ?? now) : now
  const next: Watch = {
    ...w,
    summary: r.summary,
    signature: r.signature,
    unchanged,
    changedAt,
    seen: [...(w.seen ?? []), r.signature].slice(-8),
    baseline: r.baseline ?? w.baseline,
    checks: w.checks + 1,
  }
  if (r.isDone) return { ...next, status: 'done', reason: r.summary }
  if (r.stop) return { ...next, status: 'stopped', reason: r.stop }
  const stalledMs = now - changedAt
  if (unchanged + 1 >= s.limit && stalledMs >= s.stallMs) {
    const stall = s.stallMs > 0 ? m.watch.stall(Math.floor(stalledMs / 60_000)) : ''
    return { ...next, status: 'stopped', reason: m.watch.stoppedSame(unchanged + 1, stall, r.summary) }
  }
  if (next.checks >= MAX_CHECKS) {
    return { ...next, status: 'stopped', reason: m.watch.stoppedMax(MAX_CHECKS, r.summary) }
  }
  const intervalMs = Math.min(s.baseMs * 2 ** Math.min(unchanged, 4), Math.max(s.baseMs, MAX_INTERVAL_MS))
  return { ...next, intervalMs, nextAt: now + intervalMs }
}

export const newWatch = (
  t: Target,
  id: string,
  cwd: string,
  now: number,
  s: WatchSettings,
  extra: Pick<Watch, 'expect' | 'startedBy'>,
  m: Messages,
): Watch => ({
  id,
  ...t,
  ...extra,
  cwd,
  label: labelOf(t),
  summary: m.watch.first,
  signature: '',
  unchanged: 0,
  changedAt: now,
  seen: [],
  checks: 0,
  intervalMs: s.baseMs,
  nextAt: now,
  status: 'watching',
})

export const describeWatch = (w: Watch, m: Messages) => {
  const state = w.status === 'watching' ? m.watch.watching(w.checks, w.unchanged) : w.status === 'done' ? m.watch.done : m.watch.stopped
  return `${w.label}｜${state}｜${w.reason ?? w.summary}`
}

export const notice = (w: Watch, m: Messages) => {
  const head = w.status === 'done' ? m.watch.headDone : m.watch.headStopped
  const nextStep = w.status === 'stopped' ? m.watch.nextStopped : m.watch.nextDone
  return {
    toast: `${head}｜${w.label}：${w.reason ?? w.summary}`,
    note: `${head}：${w.label}（${w.kind} ${w.target}）→ ${w.reason ?? w.summary}。${nextStep}`,
  }
}

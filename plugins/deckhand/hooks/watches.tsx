/** The deploy watch, engine side: PR, CI run and URL watches polled locally through gh and fetch, the /watch-deploy command and the watch_deploy tool. */
import { atom, read, update } from 'claude-code'
import type { On, Timer } from 'claude-code'

import type { Watch } from '../types'
import { cfg, isDesktopApp, msgs, resolveBin } from './core'
import type { Engine } from './core'
import { fingerprintBody, headerOf } from './fingerprint'
import type { Messages } from './i18n'
import type { Settings } from './settings'
import { errorText, noteForModel, text } from './state'
import { TOAST } from './ui'
import {
  advance,
  describeWatch,
  errorResult,
  failedJobs,
  ghArgs,
  isNoRepo,
  newWatch,
  notice,
  parseTarget,
  prResult,
  runResult,
  urlResult,
  withAllowedFailures,
} from './watch'
import type { CheckResult, PrView, RunItem, WatchSettings } from './watch'

export async function checkWatch($: Engine, w: Watch, m: Messages): Promise<CheckResult> {
  try {
    if (w.kind === 'url') {
      const res = await $.http.fetch(w.target, { headers: { 'cache-control': 'no-cache' } })
      // The content decides, not etag or last-modified: nodes of one CDN disagree on those.
      return urlResult(w, res.status, fingerprintBody(headerOf(res.headers, 'content-type'), res.text), res.text, m)
    }
    const gh = await resolveBin($, 'gh')
    if (w.target.startsWith('sha:') && w.target.length < 44) {
      // `gh run list --commit` matches the full SHA only: a short one lists nothing and the watch would
      // wait for a run forever. Resolve it once and keep the full one.
      const full = await $.process.run([gh, 'api', `repos/${w.repo ?? '{owner}/{repo}'}/commits/${w.target.slice(4)}`, '--jq', '.sha'], {
        cwd: w.cwd,
        timeoutMs: 30_000,
      })
      const sha = full.stdout.trim()
      if (full.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha)) {
        await update($, watchesAtom, list => list.map(x => (x.id === w.id ? { ...x, target: `sha:${sha}` } : x)))
        w = { ...w, target: `sha:${sha}` }
      }
    }
    let ran = await $.process.run([gh, ...ghArgs(w), ...(w.repo ? ['--repo', w.repo] : [])], { cwd: w.cwd, timeoutMs: 60_000 })
    if (ran.exitCode !== 0 && !w.repo && isNoRepo(ran.stderr || ran.stdout)) {
      // No repo in the working directory (a session with no folder): the repo of the latest watch that
      // named one stands in, and the watch keeps it from here on.
      const repo = [...(await read($, watchesAtom))].reverse().find(x => x.repo && x.id !== w.id)?.repo
      if (repo) {
        await update($, watchesAtom, list => list.map(x => (x.id === w.id ? { ...x, repo } : x)))
        ran = await $.process.run([gh, ...ghArgs(w), '--repo', repo], { cwd: w.cwd, timeoutMs: 60_000 })
      }
    }
    if (ran.exitCode !== 0) {
      const line = ((ran.stderr || ran.stdout).trim().split('\n')[0] ?? '').slice(0, 160) || `gh exited ${ran.exitCode}`
      return errorResult(!w.repo && isNoRepo(line) ? `${line} ${m.watch.nameRepo}` : line, m)
    }
    const json = JSON.parse(ran.stdout) as unknown
    if (w.kind === 'pr') return prResult(json as PrView, m)
    const runs = Array.isArray(json) ? (json as RunItem[]) : [json as RunItem]
    const result = runResult(runs, m)
    if (!result.isDone) return result
    // Once every run has finished: the jobs a run's own conclusion hides (continue-on-error).
    const names: string[] = []
    for (const run of runs) {
      if (!run.databaseId || run.conclusion.toLowerCase() !== 'success') continue
      const jobs = await $.process.run([gh, 'run', 'view', String(run.databaseId), '--json', 'jobs', ...(w.repo ? ['--repo', w.repo] : [])], {
        cwd: w.cwd,
        timeoutMs: 60_000,
      })
      if (jobs.exitCode !== 0) continue
      try {
        names.push(...failedJobs((JSON.parse(jobs.stdout) as { jobs?: { name?: string; conclusion?: string | null }[] }).jobs ?? []))
      } catch {
        // An unreadable answer hides nothing new: the run's own result stands.
      }
    }
    return withAllowedFailures(result, names, m)
  } catch (error) {
    return errorResult(errorText(error).slice(0, 160), m)
  }
}

export function schedule($: Engine, w: Watch, s: WatchSettings) {
  timers.get(w.id)?.cancel()
  timers.delete(w.id)
  if (w.status !== 'watching') return
  timers.set(
    w.id,
    $.clock.after(Math.max(1000, w.intervalMs), () => void runCheck($, w.id).catch(() => undefined)),
  )
}

export async function runCheck($: Engine, id: string): Promise<Watch | undefined> {
  const current = (await read($, watchesAtom)).find(w => w.id === id)
  if (!current || current.status !== 'watching') return current
  const m = await msgs($)
  const s = watchSettingsOf(await cfg($))
  const result = await checkWatch($, current, m)
  const next = advance(current, result, await $.clock.now(), s, m)
  await update($, watchesAtom, list => list.map(w => (w.id === id ? next : w)))
  schedule($, next, s)
  if (next.status !== 'watching') {
    const { toast, note } = notice(next, m)
    $.ui.toast(toast, { timeoutMs: TOAST.info })
    await $.session.append(noteForModel(note)).catch(() => undefined)
    if (next.status === 'done' && result.followUp) {
      await startWatch($, result.followUp, { startedBy: current.startedBy, repo: current.repo })
    }
  }
  return next
}

export async function startWatch(
  $: Engine,
  raw: string,
  options: { expect?: string; startedBy: 'user' | 'model'; repo?: string },
): Promise<Watch | string> {
  const m = await msgs($)
  const parsed = parseTarget(raw)
  if (!parsed) return m.watch.badTarget(raw)
  const t = !parsed.repo && options.repo ? { ...parsed, repo: options.repo } : parsed
  const existing = (await read($, watchesAtom)).find(
    w => w.status === 'watching' && w.kind === t.kind && w.target === t.target && w.repo === t.repo,
  )
  if (existing) return existing
  const now = await $.clock.now()
  // Two watches started in one millisecond would share an id: the second gets a suffix.
  const taken = new Set((await read($, watchesAtom)).map(w => w.id))
  let id = `${t.kind}-${now.toString(36)}`
  for (let n = 2; taken.has(id); n += 1) id = `${t.kind}-${now.toString(36)}-${n}`
  const watch = newWatch(t, id, await $.session.cwd(), now, watchSettingsOf(await cfg($)), {
    expect: options.expect || undefined,
    startedBy: options.startedBy,
  }, m)
  await update($, bandHiddenAtom, () => false)
  await update($, watchesAtom, list => [...list.slice(-7), watch])
  return (await runCheck($, watch.id)) ?? watch
}

export async function stopWatches($: Engine, which: string) {
  const m = await msgs($)
  const hits = (await read($, watchesAtom)).filter(
    w => w.status === 'watching' && (which === 'all' || w.id === which || w.label === which || w.target === which),
  )
  for (const w of hits) {
    timers.get(w.id)?.cancel()
    timers.delete(w.id)
  }
  await update($, watchesAtom, all =>
    all.map(w => (hits.some(h => h.id === w.id) ? { ...w, status: 'stopped' as const, reason: m.watch.manual } : w)),
  )
  return hits.length
}

/** The watches the band draws, oldest first. */
export async function bandWatches($: Engine) {
  return read($, watchesAtom)
}

/** Whether the person hid the watch rows (a new watch shows them again). */
export async function isBandHidden($: Engine) {
  return read($, bandHiddenAtom)
}

export async function hideWatches($: Engine) {
  await update($, bandHiddenAtom, () => true)
}

export async function clearFinished($: Engine) {
  await update($, watchesAtom, list => list.filter(w => w.status === 'watching'))
}

export async function resumeWatches($: Engine) {
  const now = await $.clock.now()
  const s = watchSettingsOf(await cfg($))
  for (const w of await read($, watchesAtom)) {
    if (w.status === 'watching') schedule($, { ...w, intervalMs: Math.max(1000, w.nextAt - now) }, s)
  }
}

export const WATCH_TOOL = 'mcp__deckhand__watch_deploy'

const watchesAtom = atom({ plugin: 'deckhand', key: 'watches' } as const, [] as Watch[])

const bandHiddenAtom = atom({ plugin: 'deckhand', key: 'isBandHidden' } as const, false)

/** Timers of running watches; module state, re-armed from `$.state` after a reload. */
const timers = new Map<string, Timer>()

export const watchSettingsOf = (s: Settings): WatchSettings => ({
  baseMs: s.watch.pollSeconds * 1000,
  // A watch that stops after one look watches nothing: at least two identical results.
  limit: Math.max(2, s.guards.repeatLimit),
  stallMs: s.watch.stallMinutes * 60_000,
})

/** The hooks of this part of the plugin; register.tsx calls this first. */
export function registerWatches(on: On) {
  // ── Deploy / PR / CI watch ──────────────────────────────────────────────

  on('command.run', { command: 'watch-deploy' }, async ($, e) => {
    const m = await msgs($)
    const args = e.args.trim()
    if (args === '' || args === 'list') {
      const list = await read($, watchesAtom)
      return { text: list.length ? list.map(w => describeWatch(w, m)).join('\n') : m.watch.none }
    }
    if (args === 'clear') {
      await clearFinished($)
      return { text: m.watch.cleared }
    }
    const stop = args.match(/^stop(?:\s+(.+))?$/)
    if (stop) return { text: m.watch.stoppedCount(await stopWatches($, stop[1]?.trim() || 'all')) }
    const expect = args.match(/\s+expect[=:]\s*(.+)$/)
    const target = expect ? args.slice(0, expect.index) : args
    const watch = await startWatch($, target, { expect: expect?.[1]?.trim(), startedBy: 'user' })
    return { text: typeof watch === 'string' ? watch : m.watch.started(describeWatch(watch, m)) }
  })

  on('tool.call', { tool: WATCH_TOOL }, async ($, e) => {
    const m = await msgs($)
    const args = e as unknown as { target?: unknown; expect?: unknown }
    const target = text(args.target).trim()
    if (!target) return { deny: m.watch.toolNeedsTarget }
    // In the desktop app the PR bar already watches the PR: a second watch would only repeat it.
    if (parseTarget(target)?.kind === 'pr' && (await isDesktopApp($))) return { deny: m.watch.desktopPr }
    const watch = await startWatch($, target, { expect: text(args.expect).trim(), startedBy: 'model' })
    if (typeof watch === 'string') return { deny: watch }
    const s = await cfg($)
    const tail = watch.status === 'watching' ? m.watch.toolWatching(m.watch.stopRule(watchSettingsOf(s).limit, s.watch.stallMinutes)) : m.watch.toolFinished
    return { result: `${describeWatch(watch, m)}\n${tail}` }
  }).catch(async ($, _e, next) => ({ deny: (await msgs($)).watch.toolError(errorText(next.error)) }))
}

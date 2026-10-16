/** Delegate runs and records: the band's progress rows for each delegate.py run, and the records pane with every answer of the last 3 days. */
import { atom, read, update } from 'claude-code'
import type { On, Timer } from 'claude-code'

import type { DelegateAnswer, DelegateRecord, DelegateRun } from '../types'
import { ago } from './codex'
import { asRecord, currentLocale, msgs, msgsForDrawing, resolveBin } from './core'
import type { Engine } from './core'
import {
  exitCodeOf,
  matchRecord,
  parseDelegateOutput,
  parseMetaUsage,
  parseRecords,
  parseTaskNotification,
  pasteAnswer,
  recordResult,
  recordsTotal,
  whoOf,
} from './runs'
import type { DelegateCall } from './runs'
import { errorText, lastLine, text } from './state'
import { listRoom, TOAST, TONE } from './ui'
import { clearFinished } from './watches'

/**
 * The last four runs, for the band. While one runs, the tick is read too, so the band is drawn again every
 * second and its elapsed time moves.
 */
export async function bandRuns($: Engine) {
  const runs = (await read($, delegateRunsAtom)).slice(-4)
  if (runs.some(r => r.status === 'running')) await read($, delegateTickAtom)
  return runs
}

export async function startRun($: Engine, call: DelegateCall, id: string) {
  const run: DelegateRun = {
    id,
    label: call.label,
    tool: call.tool,
    name: call.name,
    startedAt: await $.clock.now(),
    timeoutMin: call.timeoutMin,
    status: 'running',
  }
  awaitedRuns.add(id)
  await update($, delegateRunsAtom, list => [...list.filter(r => r.id !== id).slice(-7), run])
  await syncRunTimers($)
  return id
}

/** Ends a run that is still running; one that already ended keeps its first outcome. */
export async function finishRun($: Engine, id: string, patch: Partial<DelegateRun>) {
  const now = await $.clock.now()
  await update($, delegateRunsAtom, list =>
    list.map(r => (r.id === id && r.status === 'running' ? { ...r, status: 'answered' as const, ...patch, finishedAt: now } : r)),
  )
  await syncRunTimers($)
}

/** The Bash call's result: the outcome, or the background task it became. */
export async function settleRun($: Engine, id: string, ran: { deny?: string; result?: unknown; text?: string; isError?: true }) {
  if (ran.deny !== undefined) {
    await update($, delegateRunsAtom, list => list.filter(r => r.id !== id))
    await syncRunTimers($)
    return
  }
  const out = asRecord(ran.result)
  const said = ran.text ?? [text(out.stdout), text(out.stderr)].join('\n')
  if (!ran.isError && typeof out.backgroundTaskId === 'string' && out.backgroundTaskId) {
    const taskId = out.backgroundTaskId
    await update($, delegateRunsAtom, list => list.map(r => (r.id === id ? { ...r, taskId } : r)))
    return
  }
  if (out.interrupted === true) return finishRun($, id, { status: 'stopped' })
  const code = ran.isError ? exitCodeOf(said) : 0
  await finishRun($, id, { status: code === 0 ? 'answered' : 'failed', exitCode: code, ...parseDelegateOutput(said) })
  await readRunUsage($, id)
}

/** An ended run's token counts, from the meta.json in its folder (written before delegate.py printed its outcome). */
export async function readRunUsage($: Engine, id: string) {
  const run = (await read($, delegateRunsAtom)).find(r => r.id === id)
  const folder = run?.folder ?? run?.answerPath?.split('/').slice(0, -1).join('/')
  if (!run || !folder || run.usage) return
  const usage = parseMetaUsage(await $.fs.read(`${folder}/meta.json`).catch(() => ''))
  if (usage) await update($, delegateRunsAtom, list => list.map(r => (r.id === id ? { ...r, usage } : r)))
}

/** A background task's notification: ends the run that task was, with its exit code and output. */
export async function noteTaskEnded($: Engine, prompt: string) {
  const ended = parseTaskNotification(prompt)
  if (!ended) return
  const run = (await read($, delegateRunsAtom)).find(
    r =>
      r.status === 'running' &&
      ((ended.taskId !== undefined && r.taskId === ended.taskId) || (ended.toolUseId !== undefined && r.id === ended.toolUseId)),
  )
  if (!run) return
  const said = ended.outputFile ? await $.fs.read(ended.outputFile).catch(() => '') : ''
  const code = ended.exitCode ?? (ended.status === 'completed' ? 0 : undefined)
  const status = ended.status === 'killed' ? 'stopped' : code === 0 ? 'answered' : 'failed'
  await finishRun($, run.id, { status, exitCode: code, ...parseDelegateOutput(said) })
  await readRunUsage($, run.id)
}

/** `delegate.py list`: the run folders of the last 3 days, newest first. */
export async function listRecords($: Engine, dirs: readonly string[]): Promise<DelegateRecord[]> {
  const ran = await $.process.run(
    [
      await resolveBin($, 'python3'),
      `${$.plugin.root}/bin/delegate.py`,
      'list',
      '--format',
      'json',
      '--lang',
      await currentLocale($),
      ...dirs.flatMap(d => ['--dir', d]),
    ],
    { timeoutMs: 30_000 },
  )
  if (ran.exitCode !== 0) throw new Error(lastLine(ran.stderr || ran.stdout) || `exit ${ran.exitCode}`)
  return parseRecords(ran.stdout)
}

/** Looks up the runs nobody awaits in the run folders: a meta.json with an outcome ends one. */
export async function pollRuns($: Engine) {
  const runs = await read($, delegateRunsAtom)
  const open = runs.filter(r => r.status === 'running' && !awaitedRuns.has(r.id))
  if (!open.length) return
  const records = await listRecords($, runDirs(runs))
  const claimed = new Set(runs.flatMap(r => (r.folder ? [r.folder] : [])))
  for (const run of open) {
    const rec = matchRecord(run, records, claimed)
    if (!rec) continue
    claimed.add(rec.path)
    if (rec.exit === null) {
      if (!run.folder) await update($, delegateRunsAtom, list => list.map(r => (r.id === run.id ? { ...r, folder: rec.path } : r)))
      continue
    }
    await finishRun($, run.id, {
      status: rec.exit === 0 ? 'answered' : 'failed',
      exitCode: rec.exit,
      folder: rec.path,
      ...(rec.seconds !== null ? { seconds: rec.seconds } : {}),
      ...(rec.answerPath ? { answerPath: rec.answerPath } : {}),
      ...(Object.values(rec.usage).some(v => v !== null) ? { usage: rec.usage } : {}),
    })
  }
}

/** Every second while a run is in flight: the elapsed time moves; every few seconds the folders are looked up. */
export async function tickRuns($: Engine) {
  const now = await $.clock.now()
  await update($, delegateTickAtom, () => now)
  const open = (await read($, delegateRunsAtom)).filter(r => r.status === 'running' && !awaitedRuns.has(r.id))
  for (const r of open) {
    if (now - r.startedAt > r.timeoutMin * 60_000 + RUN_LOST_MARGIN_MS) await finishRun($, r.id, { status: 'lost' })
  }
  if (open.length && now - lastRunPoll >= RUN_POLL_MS) {
    lastRunPoll = now
    await pollRuns($).catch(() => undefined)
  }
}

/** Starts or stops the ticker and sets the timer that drops finished rows; after a reload, re-arms both. */
export async function syncRunTimers($: Engine) {
  const runs = await read($, delegateRunsAtom)
  const isRunning = runs.some(r => r.status === 'running')
  if (isRunning && !runTicker) runTicker = $.clock.every(1000, () => void tickRuns($).catch(() => undefined))
  if (!isRunning && runTicker) {
    runTicker.cancel()
    runTicker = null
  }
  runExpiry?.cancel()
  runExpiry = null
  const ends = runs.filter(isFinished).map(r => (r.finishedAt ?? 0) + RUN_SHOWN_MS)
  if (ends.length) {
    const wait = Math.max(1000, Math.min(...ends) - (await $.clock.now()))
    runExpiry = $.clock.after(wait, () => void dropShownRuns($).catch(() => undefined))
  }
}

export async function dropShownRuns($: Engine) {
  const now = await $.clock.now()
  await update($, delegateRunsAtom, list => list.filter(r => !isFinished(r) || (r.finishedAt ?? 0) + RUN_SHOWN_MS > now))
  await syncRunTimers($)
}

/** The band's "clear finished": finished watches and finished delegate rows alike. */
export async function clearFinishedRows($: Engine) {
  await clearFinished($)
  await update($, delegateRunsAtom, list => list.filter(r => r.status === 'running'))
  await syncRunTimers($)
}

export async function loadRecords($: Engine) {
  await update($, recordsLoadingAtom, () => true)
  try {
    const records = await listRecords($, runDirs(await read($, delegateRunsAtom)))
    await update($, recordsAtom, () => records)
    await update($, recordsErrorAtom, () => null)
  } catch (error) {
    await update($, recordsErrorAtom, () => errorText(error))
  } finally {
    await update($, recordsLoadingAtom, () => false)
  }
}

/** Opens the records pane on the list, or on one answer when one is named. */
export async function openRecords($: Engine, show?: { path: string; label: string; who: string }) {
  const m = await msgs($)
  await update($, answerAtom, () => null)
  await $.ui.open({ id: DELEGATES_PANE, title: m.delegate.recordsTitle })
  if (show) await openAnswer($, show.path, show.label, show.who)
  void loadRecords($).catch(() => undefined)
}

export async function readAnswer($: Engine, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch (error) {
    $.ui.toast((await msgs($)).delegate.readFailed(errorText(error)), { timeoutMs: TOAST.problem })
    return null
  }
}

export async function openAnswer($: Engine, path: string, label: string, who: string) {
  const answer = await readAnswer($, path)
  if (answer !== null) await update($, answerAtom, () => ({ path, label, who, text: answer }))
}

export async function copyAnswer($: Engine, path: string, surface: Parameters<Engine['ui']['copy']>[0]['surface']) {
  const m = await msgs($)
  const answer = await readAnswer($, path)
  if (answer === null) return
  const copied = await $.ui.copy({ text: answer, surface }).catch(() => ({ isCopied: false }))
  if (copied.isCopied) $.ui.toast(m.delegate.copied, { timeoutMs: TOAST.done })
}

/** Puts the answer (or, when long, where it is kept) into the prompt box; never over a draft. */
export async function answerToPrompt($: Engine, path: string, label: string, who: string) {
  const m = await msgs($)
  const box = await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))
  if (box.text.trim()) {
    $.ui.toast(m.delegate.boxBusy, { timeoutMs: TOAST.problem })
    return
  }
  const answer = await readAnswer($, path)
  if (answer === null) return
  const filled = await $.prompt
    .fill({ text: pasteAnswer({ label, who, path, text: answer }, m), mode: 'replace' })
    .catch(() => ({ isFilled: false }))
  $.ui.toast(filled.isFilled ? m.delegate.filled(label) : m.delegate.fillFailed, { timeoutMs: TOAST.info })
}

export const DELEGATES_PANE = 'deckhand-delegates'

const delegateRunsAtom = atom({ plugin: 'deckhand', key: 'delegateRuns' } as const, [] as DelegateRun[])

const delegateTickAtom = atom({ plugin: 'deckhand', key: 'delegateTick' } as const, 0)

const recordsAtom = atom({ plugin: 'deckhand', key: 'delegateRecords' } as const, [] as DelegateRecord[])

const recordsErrorAtom = atom({ plugin: 'deckhand', key: 'delegateRecordsError' } as const, null as string | null)

const recordsLoadingAtom = atom({ plugin: 'deckhand', key: 'isDelegateRecordsLoading' } as const, false)

const answerAtom = atom({ plugin: 'deckhand', key: 'delegateAnswer' } as const, null as DelegateAnswer | null)

/** How long a finished run's row stays in the band, unless cleared sooner. */
const RUN_SHOWN_MS = 10 * 60_000

/** How often a run nobody awaits (a background task, or one from before a reload) is looked up. */
const RUN_POLL_MS = 10_000

/** A run with no word this long past its time limit is given up as lost. */
const RUN_LOST_MARGIN_MS = 10 * 60_000

/** The one-second ticker while a run is in flight, and the timer that drops finished rows. */
let runTicker: Timer | null = null

let runExpiry: Timer | null = null

let lastRunPoll = 0

/** Runs whose Bash call a hook of this module still awaits: that call's result ends them. */
export const awaitedRuns = new Set<string>()

export const isFinished = (r: DelegateRun) => r.status !== 'running'

/** The folders the runs so far were kept in, for `list --dir`. */
const runDirs = (runs: readonly DelegateRun[]) => [
  ...new Set(
    runs.flatMap(r =>
      r.answerPath ? [r.answerPath.split('/').slice(0, -2).join('/')] : r.folder ? [r.folder.split('/').slice(0, -1).join('/')] : [],
    ),
  ),
]

/** The hooks of this part of the plugin; register.tsx calls this first. */
export function registerDelegates(on: On) {
  // ── Delegate records pane ───────────────────────────────────────────────

  on('command.run', { command: 'delegates' }, async $ => {
    await openRecords($)
    return { text: (await msgs($)).delegate.recordsOpened }
  })

  on('ui.render', { component: 'Pane', requestId: DELEGATES_PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const m = await msgsForDrawing($)
    const answer = await read($, answerAtom)
    if (answer) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold wrap="truncate">
            {answer.label} · {answer.who}
          </Text>
          <Box gap={1} flexWrap="wrap">
            <Button key="back" label={m.delegate.back} variant="secondary" onPress={() => void update($, answerAtom, () => null)} />
            <Button key="a-copy" label={m.delegate.copy} variant="primary" onPress={press => void copyAnswer($, answer.path, press.surface)} />
            <Button key="a-fill" label={m.delegate.toPrompt} variant="secondary" onPress={() => void answerToPrompt($, answer.path, answer.label, answer.who)} />
          </Box>
          <Markdown key="answer" text={answer.text} />
          {e.surface !== 'desktop' && (
            <Box>
              <Button key="close" label={m.common.close} role="dismiss" onPress={() => void $.ui.close({ id: DELEGATES_PANE })} />
            </Box>
          )}
        </Box>
      )
    }
    const records = await read($, recordsAtom)
    const isLoading = await read($, recordsLoadingAtom)
    const error = await read($, recordsErrorAtom)
    const now = await $.clock.now()
    const room = listRoom(e.viewport?.rows, 8, 5)
    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1} alignItems="center">
          <Text bold>{m.delegate.recordsHeading}</Text>
          <Button key="refresh" label={m.delegate.refresh} variant="secondary" onPress={() => void loadRecords($)} />
        </Box>
        {isLoading && <Text dimColor>{m.delegate.loading}</Text>}
        {error !== null && <Text color={TONE.bad}>{m.delegate.loadFailed(error)}</Text>}
        {!isLoading && error === null && records.length === 0 && <Text dimColor>{m.delegate.noRecords}</Text>}
        {records.length > 0 && (
          <Text key="total" dimColor>
            {recordsTotal(records, m)}
          </Text>
        )}
        {records.slice(0, room).map((r, i) => {
          const who = whoOf(r.tool, r.name ?? r.model, m)
          const when = r.started !== null ? ago(r.started * 1000, now, m) : '?'
          const result = recordResult(r, m)
          const path = r.answerBytes ? r.answerPath : null
          return (
            <Box key={`rec-${i}`} flexDirection="column">
              <Text bold wrap="truncate">
                {r.label} · {who}
              </Text>
              <Text dimColor wrap="truncate">
                {when} · {result}
              </Text>
              {r.firstLine ? <Text wrap="truncate">{r.firstLine}</Text> : null}
              {path ? (
                <Box gap={1} flexWrap="wrap">
                  <Button key={`open-${i}`} label={m.delegate.open} variant="secondary" onPress={() => void openAnswer($, path, r.label, who)} />
                  <Button key={`copy-${i}`} label={m.delegate.copy} variant="secondary" onPress={press => void copyAnswer($, path, press.surface)} />
                  <Button key={`fill-${i}`} label={m.delegate.toPrompt} variant="secondary" onPress={() => void answerToPrompt($, path, r.label, who)} />
                </Box>
              ) : null}
            </Box>
          )
        })}
        {records.length > room ? <Text dimColor>{m.common.more(records.length - room)}</Text> : null}
        {e.surface !== 'desktop' && (
          <Box>
            <Button key="close" label={m.common.close} role="dismiss" onPress={() => void $.ui.close({ id: DELEGATES_PANE })} />
          </Box>
        )}
      </Box>
    )
  })
}

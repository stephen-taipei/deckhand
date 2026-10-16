/** Sub5 leftovers: what interrupted runs left behind, listed and cleaned through bin/sub5.py, in a pane of their own. */
import type { Engine } from './core'
import type { On } from 'claude-code'
import type { Sub5Leftover, Sub5Leftovers } from '../types'
import { listRoom, TOAST, TONE } from './ui'
import { atom, read, update } from 'claude-code'
import { currentLocale, msgs, msgsForDrawing, resolveBin } from './core'
import { errorText } from './state'
import { isActionable, leftoverLine, leftoversArgv, parseCleaned, parseLeftovers } from './sub5'

/** What the leftovers check found, for the settings pane's line. */
export async function leftoversState($: Engine) {
  return read($, leftoversAtom)
}

/** `sub5.py list|clean` in the session's folder; clean never with `--force` (Sub5 cleanup never forces). */
export async function runLeftovers($: Engine, action: 'list' | 'clean') {
  return $.process.run(
    leftoversArgv({
      python: await resolveBin($, 'python3'),
      tool: `${$.plugin.root}/bin/sub5.py`,
      action,
      cwd: await $.session.cwd(),
      locale: await currentLocale($),
    }),
    { timeoutMs: action === 'clean' ? 180_000 : 60_000 },
  )
}

export async function loadLeftovers($: Engine): Promise<Sub5Leftover[] | null> {
  await update($, leftoversAtom, v => ({ ...v, status: 'loading' as const, error: null }))
  try {
    const ran = await runLeftovers($, 'list')
    const entries = ran.exitCode === 0 ? parseLeftovers(ran.stdout) : null
    if (!entries) throw new Error(failureOf(ran))
    await update($, leftoversAtom, v => ({ ...v, status: 'done' as const, entries, error: null }))
    return entries
  } catch (error) {
    await update($, leftoversAtom, v => ({ ...v, status: 'error' as const, entries: [], error: errorText(error), isArmed: false }))
    return null
  }
}

/** `/sub5-clean` and the Sub5 tab's button: the pane with the list; nothing is removed until its confirm press. */
export async function openLeftovers($: Engine) {
  const m = await msgs($)
  await update($, leftoversAtom, v => ({ ...v, isArmed: false }))
  await $.ui.open({ id: SUB5_CLEAN_PANE, title: m.sub5.cleanTitle })
  return loadLeftovers($)
}

export async function cleanLeftovers($: Engine) {
  const m = await msgs($)
  if ((await read($, leftoversAtom)).isCleaning) return
  await update($, leftoversAtom, v => ({ ...v, isArmed: false, isCleaning: true }))
  try {
    // Exit 1 means something was kept: the JSON is still the answer.
    const ran = await runLeftovers($, 'clean')
    const done = parseCleaned(ran.stdout)
    if (!done) throw new Error(failureOf(ran))
    $.ui.toast(m.sub5.cleaned(done.worktrees, done.branches, done.kept + done.failed), { timeoutMs: TOAST.info })
  } catch (error) {
    $.ui.toast(m.sub5.cleanError(errorText(error)), { timeoutMs: TOAST.problem })
  } finally {
    await update($, leftoversAtom, v => ({ ...v, isCleaning: false }))
  }
  await loadLeftovers($)
}

export const SUB5_CLEAN_PANE = 'deckhand-sub5-clean'

const leftoversAtom = atom({ plugin: 'deckhand', key: 'sub5Leftovers' } as const, {
  status: 'idle',
  entries: [],
  error: null,
  isArmed: false,
  isCleaning: false,
} as Sub5Leftovers)

const failureOf = (ran: { exitCode: number; stdout: string; stderr: string }) =>
  ((ran.stderr || ran.stdout).trim().split('\n').pop() ?? '').replace(/^sub5: /, '') || `exit ${ran.exitCode}`

/** The hooks of this part of the plugin; register.tsx calls this first. */
export function registerLeftovers(on: On) {
  // ── Sub5 leftovers pane ─────────────────────────────────────────────────

  on('command.run', { command: 'sub5-clean' }, async $ => {
    const m = await msgs($)
    const entries = await openLeftovers($)
    if (entries === null) return { text: m.sub5.cleanFailed((await read($, leftoversAtom)).error ?? '') }
    if (!entries.length) return { text: m.sub5.cleanNone }
    return { text: `${m.sub5.cleanSummary(entries.length, entries.filter(isActionable).length)}\n${m.sub5.cleanOpened}` }
  })

  on('ui.render', { component: 'Pane', requestId: SUB5_CLEAN_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await msgsForDrawing($)
    const state = await read($, leftoversAtom)
    const actionable = state.entries.filter(isActionable).length
    const room = listRoom(e.viewport?.rows, 8, 2)
    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{m.sub5.cleanHint}</Text>
        {state.status === 'loading' && <Text dimColor>{m.sub5.cleanLoading}</Text>}
        {state.isCleaning && <Text dimColor>{m.sub5.cleaning}</Text>}
        {state.status === 'error' && <Text color={TONE.bad}>{m.sub5.cleanFailed(state.error ?? '')}</Text>}
        {state.status === 'done' && (
          <Text bold>{state.entries.length ? m.sub5.cleanSummary(state.entries.length, actionable) : m.sub5.cleanNone}</Text>
        )}
        {state.entries.slice(0, room).map((x, i) => (
          <Box key={`lo-${i}`} flexDirection="column">
            <Text wrap="truncate">{x.path ?? x.branch}</Text>
            {/* What the clean-up would remove reads as a warning, not as a success. */}
            <Text dimColor={!isActionable(x)} color={isActionable(x) ? TONE.warn : undefined} wrap="truncate">
              {leftoverLine(x, m)}
            </Text>
          </Box>
        ))}
        {state.entries.length > room ? <Text dimColor>{m.common.more(state.entries.length - room)}</Text> : null}
        <Box gap={1} flexWrap="wrap">
          {state.isArmed ? (
            <Button key="clean-confirm" label={m.sub5.cleanConfirm(actionable)} variant="primary" onPress={() => void cleanLeftovers($).catch(() => undefined)} />
          ) : null}
          {state.isArmed ? (
            <Button key="clean-cancel" label={m.sub5.cleanCancel} variant="secondary" onPress={() => void update($, leftoversAtom, v => ({ ...v, isArmed: false }))} />
          ) : null}
          {!state.isArmed && actionable > 0 && !state.isCleaning ? (
            <Button key="clean" label={m.sub5.cleanButton(actionable)} variant="secondary" onPress={() => void update($, leftoversAtom, v => ({ ...v, isArmed: true }))} />
          ) : null}
          <Button key="refresh" label={m.sub5.cleanRefresh} variant="secondary" onPress={() => void loadLeftovers($).catch(() => undefined)} />
          {e.surface !== 'desktop' && <Button key="close" label={m.sub5.cleanClose} role="dismiss" onPress={() => void $.ui.close({ id: SUB5_CLEAN_PANE })} />}
        </Box>
      </Box>
    )
  })
}

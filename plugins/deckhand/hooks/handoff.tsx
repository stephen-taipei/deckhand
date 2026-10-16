/** Claude ↔ Codex: the handoff commands, the shared handoff tool and the Codex inbox pane. */
import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { CodexThread } from '../types'
import { ago, parseChecked, parseWritten, pastePrompt, stateLine, threadsArgv, unfence } from './codex'
import { cfg, currentLocale, msgs, msgsForDrawing, resolveBin } from './core'
import type { Engine } from './core'
import { errorText, lastLine } from './state'
import { listRoom, TOAST, TONE } from './ui'

export async function loadCodexThreads($: Engine): Promise<CodexThread[]> {
  await update($, codexLoadingAtom, () => true)
  try {
    const s = await cfg($)
    const [, ...args] = threadsArgv($.plugin.root, await $.session.root(), await read($, codexAllAtom), s.paths.codexHome)
    const ran = await $.process.run([await resolveBin($, 'python3'), ...args], { timeoutMs: 30_000 })
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n').pop() || `exit ${ran.exitCode}`)
    const threads = JSON.parse(ran.stdout) as CodexThread[]
    await update($, codexThreadsAtom, () => threads)
    await update($, codexErrorAtom, () => null)
    return threads
  } catch (error) {
    await update($, codexErrorAtom, () => errorText(error))
    return []
  } finally {
    await update($, codexLoadingAtom, () => false)
  }
}

/** Runs bin/handoff-state.py (the tool Codex runs too) in the session's working tree. */
export async function handoffTool($: Engine, args: string[], stdin?: string) {
  const locale = await currentLocale($)
  return $.process.run(
    [await resolveBin($, 'python3'), `${$.plugin.root}/bin/handoff-state.py`, ...args, '--cwd', await $.session.cwd(), '--lang', locale],
    { stdin, timeoutMs: 60_000 },
  )
}

/**
 * Keeps ~/.agent-handoff/bin/handoff-state.py equal to the plugin's copy: Codex's AGENTS.md names that
 * path, so it must not go stale when the plugin is updated. The folder is made private (700) when new.
 * Its sibling i18n.py goes along, since the tool imports it.
 */
export async function syncSharedTool($: Engine) {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    await $.process.run(['mkdir', '-p', '-m', '700', `${home}/.agent-handoff`])
    await $.process.run(['mkdir', '-p', `${home}/.agent-handoff/bin`])
    for (const name of ['handoff-state.py', 'i18n.py']) {
      const sourcePath = `${$.plugin.root}/bin/${name}`
      if (!(await $.fs.exists(sourcePath))) continue
      const source = await $.fs.read(sourcePath)
      const target = `${home}/.agent-handoff/bin/${name}`
      if ((await $.fs.exists(target)) && (await $.fs.read(target)) === source) continue
      await $.fs.write(target, source)
    }
  } catch (error) {
    $.ui.log((await msgs($)).codex.syncFailed(errorText(error)))
  }
}

export const CODEX_PANE = 'deckhand-codex'

const codexThreadsAtom = atom({ plugin: 'deckhand', key: 'codexThreads' } as const, [] as CodexThread[])

const codexErrorAtom = atom({ plugin: 'deckhand', key: 'codexError' } as const, null as string | null)

const codexLoadingAtom = atom({ plugin: 'deckhand', key: 'isCodexLoading' } as const, false)

const codexAllAtom = atom({ plugin: 'deckhand', key: 'codexAllProjects' } as const, false)

/** The hooks of this part of the plugin; register.tsx calls this first. */
export function registerHandoff(on: On) {
  // ── Claude ↔ Codex ──────────────────────────────────────────────────────

  // Codex's file is read by the tool, which compares its recorded git facts with the repo as it is
  // now; the differences go into the prompt, so the model starts from them instead of re-deriving.
  on('command.run', { command: 'handoff-in' }, async $ => {
    const m = await msgs($)
    const ran = await handoffTool($, ['check', '--from', 'codex', '--to', 'claude', '--format', 'json'])
    const checked = parseChecked(ran.stdout)
    if (!checked) return { text: m.codex.checkFailed(lastLine(ran.stderr || ran.stdout) || `exit ${ran.exitCode}`) }
    if ('error' in checked) {
      return { text: checked.error === 'missing' ? m.codex.noHandoff(checked.path) : m.codex.notToolFile(checked.path) }
    }
    await $.prompt.fill({ text: checked.nextPrompt })
    return { text: m.codex.handoffInFilled(checked.report) }
  })

  // The model writes only the narrative; the tool adds the git facts from real git, masks secrets,
  // and names the file, the same way for Codex.
  on('command.run', { command: 'handoff' }, async ($, e) => {
    const m = await msgs($)
    const forked = await $.model.fork({ prompt: m.codex.handoffPrompt(e.args.trim(), m.languageName) })
    if (!forked.isAnswered) return { text: m.codex.handoffFailed(forked.reason) }
    const ran = await handoffTool($, ['write', '--from', 'claude', '--to', 'codex'], unfence(forked.text))
    const written = ran.exitCode === 0 ? parseWritten(ran.stdout) : null
    if (!written) return { text: m.codex.writeFailed(lastLine(ran.stderr || ran.stdout) || `exit ${ran.exitCode}`) }
    const copied = await $.ui.copy({ text: written.nextPrompt }).catch(() => ({ isCopied: false as const }))
    return {
      text: [
        m.codex.file(written.path),
        stateLine(written.state, m),
        ...(written.redacted > 0 ? [m.codex.masked(written.redacted)] : []),
        m.codex.copyThis(copied.isCopied),
        '',
        written.nextPrompt,
      ].join('\n'),
    }
  })

  on('command.run', { command: 'codex' }, async ($, e) => {
    const m = await msgs($)
    await update($, codexAllAtom, () => e.args.trim() === 'all')
    await $.ui.open({ id: CODEX_PANE, title: m.codex.paneTitle })
    void loadCodexThreads($)
    return { text: m.codex.opened }
  })

  on('command.run', { command: 'codex-latest' }, async $ => {
    const m = await msgs($)
    await update($, codexAllAtom, () => false)
    const [latest] = await loadCodexThreads($)
    if (!latest) return { text: m.codex.noThreads((await read($, codexErrorAtom)) ?? '') }
    await $.prompt.fill({ text: pastePrompt(latest, m) })
    return { text: m.codex.latestFilled(latest.name) }
  })

  on('ui.render', { component: 'Pane', requestId: CODEX_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await msgsForDrawing($)
    const threads = await read($, codexThreadsAtom)
    const isLoading = await read($, codexLoadingAtom)
    const isAll = await read($, codexAllAtom)
    const error = await read($, codexErrorAtom)
    const now = await $.clock.now()
    const room = listRoom(e.viewport?.rows, 8, 5)

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1} alignItems="center" flexWrap="wrap">
          <Text bold>
            {isAll ? m.codex.allProjects : m.codex.thisProject} · {m.codex.last7}
          </Text>
          <Button key="refresh" label={m.codex.refresh} variant="secondary" onPress={() => void loadCodexThreads($)} />
          <Button
            key="scope"
            label={isAll ? m.codex.onlyThis : m.codex.showAll}
            variant="secondary"
            onPress={async () => {
              await update($, codexAllAtom, all => !all)
              await loadCodexThreads($)
            }}
          />
        </Box>
        {isLoading && <Text dimColor>{m.codex.loading}</Text>}
        {error !== null && <Text color={TONE.bad}>{m.codex.loadFailed(error)}</Text>}
        {!isLoading && error === null && threads.length === 0 && <Text dimColor>{m.codex.none}</Text>}
        {threads.slice(0, room).map((t, i) => (
          <Box key={`t-${i}`} flexDirection="column">
            <Text bold wrap="truncate">
              {t.name}
            </Text>
            <Text dimColor wrap="truncate">
              {ago(t.updatedAt, now, m)} · {t.cwd.split('/').slice(-2).join('/')}
            </Text>
            <Text wrap="truncate">{t.lastAssistant.replace(/\s+/g, ' ').slice(0, 200)}</Text>
            <Box gap={1} flexWrap="wrap">
              <Button key={`fill-${i}`} label={m.codex.fill} variant="secondary" onPress={() => void $.prompt.fill({ text: pastePrompt(t, m) })} />
              <Button
                key={`copy-${i}`}
                label={m.codex.copyReply}
                variant="secondary"
                onPress={async press => {
                  const copied = await $.ui.copy({ text: t.lastAssistant, surface: press.surface }).catch(() => ({ isCopied: false }))
                  if (copied.isCopied) $.ui.toast(m.common.copied, { timeoutMs: TOAST.done })
                }}
              />
            </Box>
          </Box>
        ))}
        {threads.length > room ? <Text dimColor>{m.common.more(threads.length - room)}</Text> : null}
        {e.surface !== 'desktop' && (
          <Box>
            <Button key="close" label={m.common.close} role="dismiss" onPress={() => void $.ui.close({ id: CODEX_PANE })} />
          </Box>
        )}
      </Box>
    )
  })
}

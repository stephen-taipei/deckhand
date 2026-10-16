/** The Recap button: a fork of the conversation retells it in plain words, in a pane of its own. */
import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { RecapState } from '../types'
import { unfence } from './codex'
import { msgs, msgsForDrawing } from './core'
import type { Engine } from './core'
import { errorText } from './state'
import { TOAST, TONE } from './ui'

/** The pane's id: declared here, beside the hooks whose matcher names it, so the engine reads it as written. */
export const RECAP_PANE = 'deckhand-recap'

const recapAtom = atom({ plugin: 'deckhand', key: 'recap' } as const, { status: 'idle', text: '', at: 0 } as RecapState)

// ── Recap ───────────────────────────────────────────────────────────────────

let isRecapRunning = false

/**
 * The recap button: a fork of the conversation retells it in plain words, shown in a pane. The fork
 * reads the whole context but adds nothing to it: the conversation stays as it was.
 */
export async function startRecap($: Engine) {
  const m = await msgs($)
  await $.ui.open({ id: RECAP_PANE, title: m.recap.paneTitle })
  if (isRecapRunning) {
    $.ui.toast(m.recap.guard, { timeoutMs: TOAST.problem })
    return
  }
  isRecapRunning = true
  await update($, recapAtom, () => ({ status: 'working', text: '', at: 0 }))
  try {
    const forked = await $.model.fork({ prompt: m.recap.prompt(m.languageName) })
    const at = await $.clock.now()
    if (!forked.isAnswered) {
      const why = forked.reason === 'nothing-to-fork' ? m.recap.nothing : m.recap.failed(forked.reason)
      await update($, recapAtom, () => ({ status: 'error', text: why, at }))
    } else {
      await update($, recapAtom, () => ({ status: 'done', text: unfence(forked.text), at }))
    }
  } catch (error) {
    await update($, recapAtom, () => ({ status: 'error', text: m.recap.failed(errorText(error)), at: 0 }))
  } finally {
    isRecapRunning = false
  }
}


/** The recap pane's hooks. */
export function registerRecap(on: On) {
  // ── Recap pane ──────────────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: RECAP_PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const m = await msgsForDrawing($)
    const recap = await read($, recapAtom)
    return (
      <Box flexDirection="column" gap={1}>
        {recap.status === 'working' && <Text dimColor>{m.recap.working}</Text>}
        {recap.status === 'error' && <Text color={TONE.bad}>{recap.text}</Text>}
        {recap.status === 'done' && <Markdown key="recap-text" text={recap.text} />}
        <Box gap={1}>
          {recap.status === 'done' && (
            <Button
              key="copy"
              label={m.recap.copy}
              variant="primary"
              onPress={async press => {
                const copied = await $.ui.copy({ text: recap.text, surface: press.surface }).catch(() => ({ isCopied: false }))
                if (copied.isCopied) $.ui.toast(m.common.copied, { timeoutMs: TOAST.done })
              }}
            />
          )}
          <Button key="again" label={m.recap.again} variant="secondary" onPress={() => void startRecap($)} />
          {e.surface !== 'desktop' && <Button key="close" label={m.recap.close} role="dismiss" onPress={() => void $.ui.close({ id: RECAP_PANE })} />}
        </Box>
      </Box>
    )
  })

}

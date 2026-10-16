/** Handing work to the main agent: the Sub5 and delegate buttons, and the hand-over that waits for a running turn to end. */
import { cfg, currentLocale, msgs } from './core'
import type { Engine } from './core'
import { delegatePrompt, targetLabel } from './delegate'
import type { DelegateTarget, DelegateTool } from './settings'
import { errorText } from './state'
import { sub5Prompt } from './sub5'
import { TOAST } from './ui'

/**
 * What the Sub5 and delegate buttons hand the main agent: the full brief as a row only the model reads,
 * then one short line in the person's name, so the transcript shows the request and not the procedure.
 * If the engine will not take the row, the brief goes as the prompt itself, as before.
 */
export async function handOver($: Engine, visible: string, brief: string) {
  const row = await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text: brief }] } })
    .catch(() => ({ deny: 'failed' }) as const)
  await $.prompt.submit({ text: row.deny ? brief : visible, asUser: true })
}

/** The main turn ended: a hand-over held while it ran goes now. */
export function sendHeldHandOver($: Engine) {
  const held = heldHandOver
  if (!held) return
  heldHandOver = null
  // After the turn has ended: a hook may not start the next turn itself.
  $.clock.after(10, () => void handOver($, held.visible, held.brief).catch(error => $.ui.log(`deckhand: hand-over not sent (${errorText(error)})`)))
}

/** Now when idle; when a turn runs, held for its end (the brief row would otherwise reach that turn). */
export async function handOverWhenIdle($: Engine, visible: string, brief: string, isWorking: boolean) {
  if (isWorking) {
    heldHandOver = { visible, brief }
    return
  }
  await handOver($, visible, brief)
}

/** The Sub5 button and `/sub5`: hands the main agent the flow as the user's own instruction. */
export async function startSub5($: Engine, note: string, isWorking: boolean) {
  const m = await msgs($)
  const s = await cfg($)
  const now = await $.clock.now()
  if (now - lastSub5At < 8_000) {
    $.ui.toast(m.sub5.guard, { timeoutMs: TOAST.problem })
    return false
  }
  lastSub5At = now
  $.ui.toast(isWorking ? m.sub5.queued : m.sub5.sent, { timeoutMs: TOAST.info })
  try {
    const brief = sub5Prompt(
      { ...s.sub5, tool: `${$.plugin.root}/bin/sub5.py`, note, locale: await currentLocale($), attribution: s.guards.attribution },
      m,
    )
    await handOverWhenIdle($, m.sub5.visible(note.trim() || m.delegate.currentTask), brief, isWorking)
  } catch (error) {
    lastSub5At = 0
    $.ui.toast(m.sub5.failed(errorText(error)), { timeoutMs: TOAST.problem })
    return false
  }
  return true
}

/**
 * A delegate button, or `/delegate`: hands the main agent one delegation to an outside model, as the
 * user's own instruction. The task is `task` when one is given, else (`useDraft`) the draft in the
 * prompt box, else the conversation's current work. This never touches the main agent's model or effort.
 */
export async function startDelegate($: Engine, target: DelegateTarget, task: string, isWorking: boolean, useDraft: boolean) {
  const m = await msgs($)
  const s = await cfg($)
  const now = await $.clock.now()
  if (now - lastDelegateAt < 8_000) {
    $.ui.toast(m.delegate.guard, { timeoutMs: TOAST.problem })
    return false
  }
  lastDelegateAt = now
  let taskText = task.trim()
  let draft = ''
  if (!taskText && useDraft) {
    // Only a surface that gives the plugin its prompt box has a draft to read; the others read ''.
    draft = (await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))).text.trim()
    taskText = draft
  }
  // The draft leaves the box now, not after the turn: `submit` waits for the turn, and a draft left
  // standing could be sent a second time.
  if (draft) await $.prompt.fill({ text: '' }).catch(() => undefined)
  const source = draft ? m.delegate.fromBox : taskText ? m.delegate.fromCommand : m.delegate.currentWork
  const label = targetLabel(target, m)
  $.ui.toast(isWorking ? m.delegate.queued(target.key, label, source) : m.delegate.sent(target.key, label, source), { timeoutMs: TOAST.info })
  const explicit: Record<DelegateTool, string> = { codex: s.paths.codexBin, agent: s.paths.agentBin, agy: s.paths.agyBin }
  try {
    const brief = delegatePrompt(
      {
        tool: `${$.plugin.root}/bin/delegate.py`,
        target,
        locale: await currentLocale($),
        bin: explicit[target.tool] || undefined,
        codexHome: s.paths.codexHome || undefined,
        task: taskText,
        attribution: s.guards.attribution,
      },
      m,
    )
    await handOverWhenIdle($, m.delegate.visible(target.key, label, taskText || m.delegate.currentTask), brief, isWorking)
  } catch (error) {
    lastDelegateAt = 0
    if (draft) await $.prompt.fill({ text: draft }).catch(() => undefined)
    $.ui.toast(m.delegate.failed(target.key, errorText(error)), { timeoutMs: TOAST.problem })
    return false
  }
  return true
}

/** A hand-over pressed while a turn ran: sent when that turn ends, so the running turn never reads it. */
let heldHandOver: { visible: string; brief: string } | null = null

let lastSub5At = 0

let lastDelegateAt = 0

/**
 * Intent Galaxy (github.com/stephen-taipei/intent-galaxy), when the person has its MCP server: the iG
 * button hands the main agent the two-step flow (intent_spawner_prompt, then intent_open_galaxy) on the
 * draft in the prompt box, and the band shows a row while the galaxy waits for the person to lock it.
 */
import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { GalaxyView } from '../types'
import { currentLocale, msgs } from './core'
import type { Engine } from './core'
import { handOverWhenIdle } from './actions'
import { LANGUAGE_NAME } from './locales'
import { errorText } from './state'
import { TOAST } from './ui'

/** The two tools, whatever the person named the server: `mcp__<server>__intent_spawner_prompt` and `..._open_galaxy`. */
export const SPAWNER_SUFFIX = '__intent_spawner_prompt'
export const OPEN_SUFFIX = '__intent_open_galaxy'

const galaxyAtom = atom({ plugin: 'deckhand', key: 'galaxy' } as const, { spawner: '', open: '', isOpen: false } as GalaxyView)

/** The pair of tools one server offers, or null when no connected server offers both. */
export const galaxyTools = (names: readonly string[]): { spawner: string; open: string } | null => {
  for (const open of names) {
    if (!open.startsWith('mcp__') || !open.endsWith(OPEN_SUFFIX)) continue
    const spawner = open.slice(0, -OPEN_SUFFIX.length) + SPAWNER_SUFFIX
    if (names.includes(spawner)) return { spawner, open }
  }
  return null
}

export async function galaxyState($: Engine) {
  return read($, galaxyAtom)
}

/** Looks for the tools again: MCP servers connect after the session starts, and may come and go. */
export async function detectGalaxy($: Engine) {
  const tools = await $.tool.list().catch(() => null)
  if (!tools) return
  const found = galaxyTools(tools.filter(t => t.mcp).map(t => t.name))
  await update($, galaxyAtom, (g): GalaxyView => ({ ...g, spawner: found?.spawner ?? '', open: found?.open ?? '' }))
}

/** While intent_open_galaxy waits for the lock, the band says so. */
export async function markGalaxyOpen($: Engine, isOpen: boolean) {
  await update($, galaxyAtom, (g): GalaxyView => ({ ...g, isOpen }))
}

/** What the iG button hands the main agent. English: only the model reads it; it answers in the person's language. */
export const galaxyBrief = (o: { goal: string; spawner: string; open: string; languageName: string }) =>
  [
    "[iG] I (the user) pressed Deckhand's iG button: run Intent Galaxy on the goal below. Don't ask me first.",
    '',
    o.goal
      ? `Goal (my words; pass it verbatim):\n<goal>\n${o.goal}\n</goal>`
      : `Goal: I gave none. State the goal of the current work in this conversation in one sentence, in ${o.languageName}, show it to me, and use that sentence verbatim as the goal.`,
    '',
    'Steps',
    `1. Call \`${o.spawner}\` with { "goal": <the goal> }.`,
    `2. Follow the rules it returns exactly and write the IntentAnalysisResponse JSON yourself, its human-readable text in ${o.languageName}. Don't call another model for it.`,
    `3. Tell me in one line that the galaxy opens in my browser and how to drive it: 1 / 2 / 3 apply a strategy, Space adopts a node, x excludes one, Enter locks. Then call \`${o.open}\` with { "goal": <the goal>, "analysis": <that JSON> }; it waits until I lock the galaxy.`,
    '4. If it rejects the JSON, fix the findings it lists and call it again, at most twice; then stop and tell me why.',
    '5. When it returns the LOCKED INTENT AST: show the AST, then sum it up in at most 3 lines. From then on, follow the AST as hard constraints. Don\'t start the work until I say so.',
    '',
    `Answer in ${o.languageName}.`,
  ].join('\n')

/**
 * The iG button: the draft in the prompt box is the goal (it leaves the box now, so it is not sent twice);
 * with none, the conversation's current work. Nothing happens when the tools have gone.
 */
export async function startGalaxy($: Engine, isWorking: boolean) {
  const m = await msgs($)
  const now = await $.clock.now()
  if (now - lastGalaxyAt < 8_000) {
    $.ui.toast(m.galaxy.guard, { timeoutMs: TOAST.problem })
    return false
  }
  await detectGalaxy($)
  const g = await read($, galaxyAtom)
  if (!g.open) {
    $.ui.toast(m.galaxy.missing, { timeoutMs: TOAST.problem })
    return false
  }
  lastGalaxyAt = now
  const draft = (await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))).text.trim()
  if (draft) await $.prompt.fill({ text: '' }).catch(() => undefined)
  $.ui.toast(isWorking ? m.galaxy.queued : m.galaxy.sent, { timeoutMs: TOAST.info })
  try {
    const brief = galaxyBrief({ goal: draft, spawner: g.spawner, open: g.open, languageName: LANGUAGE_NAME[await currentLocale($)] })
    await handOverWhenIdle($, m.galaxy.visible(draft || m.delegate.currentTask), brief, isWorking)
  } catch (error) {
    lastGalaxyAt = 0
    if (draft) await $.prompt.fill({ text: draft }).catch(() => undefined)
    $.ui.toast(m.galaxy.failed(errorText(error)), { timeoutMs: TOAST.problem })
    return false
  }
  return true
}

let lastGalaxyAt = 0

/** The hooks of this part of the plugin; register.tsx calls this first. */
export function registerGalaxy(on: On) {
  // The galaxy's tool blocks until the person locks it in the browser: the band shows a row meanwhile.
  on('tool.call', async ($, e, next) => {
    if (!e.tool.startsWith('mcp__') || !e.tool.endsWith(OPEN_SUFFIX)) return next(e)
    await markGalaxyOpen($, true)
    try {
      return await next(e)
    } finally {
      await markGalaxyOpen($, false)
    }
  })
}

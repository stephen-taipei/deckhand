/**
 * Intent Galaxy (github.com/stephen-taipei/intent-galaxy) behind the iG button. With its MCP server
 * connected, the button hands the main agent the two-step flow on that server's tools. Without it, the
 * first press offers to install the npm package into Deckhand's own folder (bin/galaxy.py); once the
 * person agrees, Deckhand registers the same two tools itself and runs the package behind them, so iG
 * works in the same conversation, with no change to the person's MCP config. While a galaxy waits for
 * its lock, the band says how to drive it.
 */
import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { GalaxyView } from '../types'
import { handOverWhenIdle } from './actions'
import { currentLocale, msgs, msgsForDrawing, resolveBin } from './core'
import type { Engine } from './core'
import { LANGUAGE_NAME } from './locales'
import { errorText, lastLine } from './state'
import { TOAST, TONE } from './ui'

/** The two tools, whatever the person named the server: `mcp__<server>__intent_spawner_prompt` and `..._open_galaxy`. */
export const SPAWNER_SUFFIX = '__intent_spawner_prompt'
export const OPEN_SUFFIX = '__intent_open_galaxy'

/** Deckhand's own pair, registered once the package is installed in its folder. */
const OWN_SPAWNER = 'mcp__deckhand__intent_spawner_prompt'
const OWN_OPEN = 'mcp__deckhand__intent_open_galaxy'

/** The install pane's id: declared here, beside the hook whose matcher names it. */
export const GALAXY_PANE = 'deckhand-galaxy'

const galaxyAtom = atom({ plugin: 'deckhand', key: 'galaxy' } as const, {
  spawner: '',
  open: '',
  isOpen: false,
  setup: 'checking',
  node: '',
  needs: '22.18',
  error: '',
} as GalaxyView)

/** The pair of tools one server offers, a connected Intent Galaxy server before Deckhand's own; null when none offers both. */
export const galaxyTools = (names: readonly string[]): { spawner: string; open: string } | null => {
  const pairs = names
    .filter(open => open.startsWith('mcp__') && open.endsWith(OPEN_SUFFIX))
    .map(open => ({ spawner: open.slice(0, -OPEN_SUFFIX.length) + SPAWNER_SUFFIX, open }))
    .filter(p => names.includes(p.spawner))
  return pairs.find(p => p.open !== OWN_OPEN) ?? pairs[0] ?? null
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

type HelperStatus = { node: string | null; nodeOk: boolean; needs: string; npm: boolean; installed: boolean; version: string; error?: string; detail?: string[] }

async function helperStatus($: Engine, args: string[] = ['status'], timeoutMs = 30_000): Promise<HelperStatus | null> {
  const ran = await $.process.run([await resolveBin($, 'python3'), `${$.plugin.root}/bin/galaxy.py`, ...args], { timeoutMs }).catch(() => null)
  try {
    return ran ? (JSON.parse(lastLine(ran.stdout)) as HelperStatus) : null
  } catch {
    return null
  }
}

/** Offers Deckhand's own pair of tools: called once the package is in Deckhand's folder. */
export async function registerOwnTools($: Engine) {
  await $.tool.register({
    name: 'intent_spawner_prompt',
    description:
      'Step 1 of the Intent Galaxy flow (run by Deckhand). Returns the INTENT-SPAWNER system prompt and wire schema for a goal. ' +
      'Generate the IntentAnalysisResponse JSON yourself by following it exactly, then call mcp__deckhand__intent_open_galaxy with that JSON.',
    inputSchema: {
      type: 'object',
      properties: { goal: { type: 'string', description: "The user's fuzzy goal, verbatim." } },
      required: ['goal'],
    },
  })
  await $.tool.register({
    name: 'intent_open_galaxy',
    description:
      'Step 2 of the Intent Galaxy flow (run by Deckhand). Validates and repairs an IntentAnalysisResponse JSON, opens the 12-node galaxy ' +
      'in the browser, waits until the user locks it with Enter, and returns the LOCKED INTENT AST markdown. Follow the AST as hard constraints.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: "The user's goal, verbatim." },
        analysis: { description: 'IntentAnalysisResponse object (or its JSON string) produced from intent_spawner_prompt.' },
      },
      required: ['analysis'],
    },
  })
}

/** At session start: when the package is already in Deckhand's folder, its tools are offered again. */
export async function offerInstalled($: Engine) {
  const s = await helperStatus($)
  if (s?.installed && s.nodeOk) await registerOwnTools($)
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
    "5. When it returns the LOCKED INTENT AST: show the AST, then sum it up in at most 3 lines. From then on, follow the AST as hard constraints. Don't start the work until I say so.",
    '',
    `Answer in ${o.languageName}.`,
  ].join('\n')

/** The goal the press took from the prompt box, kept while the install pane is up so it goes once the install is done. */
let pendingGoal: string | null = null

let lastGalaxyAt = 0

async function handOverGalaxy($: Engine, goal: string, isWorking: boolean) {
  const m = await msgs($)
  const g = await read($, galaxyAtom)
  $.ui.toast(isWorking ? m.galaxy.queued : m.galaxy.sent, { timeoutMs: TOAST.info })
  const brief = galaxyBrief({ goal, spawner: g.spawner, open: g.open, languageName: LANGUAGE_NAME[await currentLocale($)] })
  await handOverWhenIdle($, m.galaxy.visible(goal || m.delegate.currentTask), brief, isWorking)
}

/**
 * The iG button: the draft in the prompt box is the goal (it leaves the box now, so it is not sent twice);
 * with none, the conversation's current work. Without the tools, the install pane asks first.
 */
export async function startGalaxy($: Engine, isWorking: boolean) {
  const m = await msgs($)
  const now = await $.clock.now()
  if (now - lastGalaxyAt < 8_000) {
    $.ui.toast(m.galaxy.guard, { timeoutMs: TOAST.problem })
    return false
  }
  lastGalaxyAt = now
  const draft = (await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))).text.trim()
  if (draft) await $.prompt.fill({ text: '' }).catch(() => undefined)
  try {
    await detectGalaxy($)
    if (!(await read($, galaxyAtom)).open) {
      // Installed in an earlier session but not offered yet: offer the tools and look again.
      const s = await helperStatus($)
      if (s?.installed && s.nodeOk) {
        await registerOwnTools($)
        await detectGalaxy($)
      }
    }
    if ((await read($, galaxyAtom)).open) {
      await handOverGalaxy($, draft, isWorking)
      return true
    }
    pendingGoal = draft
    await openSetup($)
    return false
  } catch (error) {
    lastGalaxyAt = 0
    if (draft) await $.prompt.fill({ text: draft }).catch(() => undefined)
    $.ui.toast(m.galaxy.failed(errorText(error)), { timeoutMs: TOAST.problem })
    return false
  }
}

/** The install pane: what Deckhand found, and an install that waits for the person's press. */
export async function openSetup($: Engine) {
  const m = await msgs($)
  await update($, galaxyAtom, (g): GalaxyView => ({ ...g, setup: 'checking', error: '' }))
  await $.ui.open({ id: GALAXY_PANE, title: m.galaxy.setupTitle, focus: true })
  const s = await helperStatus($)
  await update($, galaxyAtom, (g): GalaxyView => ({
    ...g,
    node: s?.node ?? '',
    needs: s?.needs ?? g.needs,
    setup: !s ? 'failed' : s.nodeOk && s.npm ? 'ready' : 'no-node',
    error: s ? '' : m.galaxy.helperFailed,
  }))
}

/** The press on Install: npm puts the package in Deckhand's folder, the tools are offered, and the held goal goes. */
export async function installGalaxy($: Engine) {
  const m = await msgs($)
  await update($, galaxyAtom, (g): GalaxyView => ({ ...g, setup: 'installing', error: '' }))
  const s = await helperStatus($, ['install'], 360_000)
  if (!s?.installed) {
    const why = s?.error === 'node' || s?.error === 'npm' ? m.galaxy.setupNoNode(s.needs) : (s?.detail ?? []).join(' ') || m.galaxy.helperFailed
    await update($, galaxyAtom, (g): GalaxyView => ({ ...g, setup: 'failed', error: why }))
    return false
  }
  await registerOwnTools($)
  await detectGalaxy($)
  await $.ui.close({ id: GALAXY_PANE }).catch(() => undefined)
  $.ui.toast(m.galaxy.installed(s.version), { timeoutMs: TOAST.done })
  const goal = pendingGoal ?? ''
  pendingGoal = null
  if ((await read($, galaxyAtom)).open) await handOverGalaxy($, goal, false)
  return true
}

/** One of Deckhand's own tools: bin/galaxy.py starts the package's server, calls the tool once, and answers. */
async function callOwn($: Engine, tool: string, args: Record<string, unknown>, isLong: boolean) {
  const argv = [await resolveBin($, 'python3'), `${$.plugin.root}/bin/galaxy.py`, 'call', tool, '--cwd', await $.session.cwd(), '--lang', await currentLocale($)]
  const input = JSON.stringify({ goal: args.goal, analysis: args.analysis })
  let out = ''
  if (isLong) {
    // The galaxy waits for the person's lock, up to 30 minutes: longer than a one-shot run may take.
    for await (const piece of $.process.spawn({ argv, input })) if (piece.stream === 'stdout') out += piece.text
  } else {
    out = (await $.process.run(argv, { stdin: input, timeoutMs: 60_000 })).stdout
  }
  const answer = JSON.parse(lastLine(out) || '{}') as { text?: string; isError?: boolean }
  return answer.isError || typeof answer.text !== 'string' ? { deny: answer.text || 'Intent Galaxy gave no answer.' } : { result: answer.text }
}

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

  on('tool.call', { tool: OWN_SPAWNER }, async ($, e) => callOwn($, 'intent_spawner_prompt', e as unknown as Record<string, unknown>, false)).catch(
    async ($, _e, next) => ({ deny: (await msgs($)).galaxy.failed(errorText(next.error)) }),
  )

  on('tool.call', { tool: OWN_OPEN }, async ($, e) => callOwn($, 'intent_open_galaxy', e as unknown as Record<string, unknown>, true)).catch(
    async ($, _e, next) => ({ deny: (await msgs($)).galaxy.failed(errorText(next.error)) }),
  )

  on('ui.render', { component: 'Pane', requestId: GALAXY_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await msgsForDrawing($)
    const g = await read($, galaxyAtom)
    return (
      <Box flexDirection="column" gap={1}>
        <Text>{m.galaxy.setupIntro}</Text>
        <Text dimColor>{m.galaxy.setupWhat}</Text>
        {g.setup === 'checking' && <Text dimColor>{m.galaxy.setupChecking}</Text>}
        {g.setup === 'no-node' && <Text color={TONE.warn}>{m.galaxy.setupNoNode(g.needs)}</Text>}
        {g.setup === 'ready' && <Text color={TONE.ok}>{m.galaxy.setupNode(g.node)}</Text>}
        {g.setup === 'installing' && <Text dimColor>{m.galaxy.setupInstalling}</Text>}
        {g.setup === 'failed' && <Text color={TONE.bad}>{m.galaxy.installFailed(g.error)}</Text>}
        <Box gap={1}>
          {(g.setup === 'ready' || g.setup === 'failed') && (
            <Button key="galaxy-install" label={m.galaxy.setupInstall} variant="primary" onPress={() => void installGalaxy($).catch(() => undefined)} />
          )}
          <Button key="galaxy-cancel" label={m.galaxy.setupCancel} variant="secondary" role="dismiss" onPress={() => void $.ui.close({ id: GALAXY_PANE })} />
        </Box>
      </Box>
    )
  })
}

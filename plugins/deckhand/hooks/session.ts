/** What a session registers and checks once its settings are known: the commands, the Sub5 worker, the translate and search tools, the CLIs and the update notice. */
import { atom, read, update } from 'claude-code'

import { asRecord, cfg, msgs, resolveBin } from './core'
import type { Engine } from './core'
import type { Messages } from './i18n'
import { SEARCH_SCHEMA } from './search'
import { DEFAULT_SEARCH_SLOT, DEFAULT_TRANSLATE_SLOT, DELEGATE_TOOLS } from './settings'
import type { DelegateTool, Settings } from './settings'
import { errorText } from './state'
import { SUB5_AGENT, workerSpec } from './sub5'
import { TRANSLATE_SCHEMA } from './translate'
import { TOAST } from './ui'
import { isCheckDue, isNewer, latestVersion, readUpdateState, RELEASES_URL } from './updates'
import { watchSettingsOf } from './watches'

/**
 * A translate or search tool exists only once the person turns it on: with it off, the main model
 * never sees it. There is no unregistering, so turning it off mid-session leaves it refusing calls.
 */
export async function registerAssist($: Engine, s: Settings, kind: Assist) {
  if (!s[kind].enabled) return
  await $.tool.register({ name: kind, ...ASSIST_TOOLS[kind] })
}

export async function registerCommands($: Engine, m: Messages, s: Settings) {
  const rule = m.watch.stopRule(watchSettingsOf(s).limit, s.watch.stallMinutes)
  const keys = s.delegates.filter(t => t.enabled).map(t => t.key).join('|')
  await $.command.register({ name: 'watch-deploy', description: m.watch.commandDescription(rule), argumentHint: m.watch.commandHint })
  await $.command.register({ name: 'handoff', description: m.codex.handoffDescription, argumentHint: m.codex.handoffHint })
  await $.command.register({ name: 'codex', description: m.codex.codexDescription, argumentHint: m.codex.codexHint })
  await $.command.register({ name: 'codex-latest', description: m.codex.latestDescription })
  await $.command.register({ name: 'handoff-in', description: m.codex.handoffInDescription })
  await $.command.register({ name: 'sub5', description: m.sub5.commandDescription(s.sub5.max), argumentHint: m.sub5.commandHint })
  await $.command.register({ name: 'sub5-clean', description: m.sub5.cleanDescription })
  await $.command.register({ name: 'delegate', description: m.delegate.commandDescription(keys.replace(/\|/g, '/')), argumentHint: m.delegate.commandHint(keys) })
  await $.command.register({ name: 'delegates', description: m.delegate.recordsDescription })
  await $.command.register({ name: 'usage-raw', description: m.usage.rawCommand })
  await $.command.register({ name: 'deckhand', description: m.settings.commandDescription })
}

export async function registerWorker($: Engine, m: Messages, s: Settings) {
  await $.agent
    .register(workerSpec({ model: s.sub5.model, effort: s.sub5.effort, languageName: m.languageName, attribution: s.guards.attribution }))
    .catch(error => $.ui.log(`deckhand: ${SUB5_AGENT} not registered (${errorText(error)})`))
}

/**
 * Once a day at most: the newest GitHub Release against the installed version. A newer one gets one toast,
 * once per version; the setting `updates.check` turns this off. Failures stay quiet: the next session asks again.
 */
export async function checkForUpdate($: Engine) {
  if (!(await cfg($)).updates.check) return
  const now = await $.clock.now()
  const state = readUpdateState(await $.store.get('updateCheck').catch(() => undefined))
  if (!isCheckDue(state, now)) return
  await $.store.set('updateCheck', { ...state, checkedAt: now }).catch(() => undefined)
  const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
  const current = typeof manifest.version === 'string' ? manifest.version : ''
  const res = await $.http.fetch(RELEASES_URL, { headers: { accept: 'application/vnd.github+json' } })
  if (!res.ok) return
  const latest = latestVersion(res.text)
  if (!latest || !isNewer(latest, current) || state.notified === latest) return
  await $.store.set('updateCheck', { checkedAt: now, notified: latest }).catch(() => undefined)
  $.ui.toast((await msgs($)).updates.available(latest, current), { timeoutMs: TOAST.action })
}

/** Which CLIs were found (null: looked for and missing; absent: not checked yet). */
export async function foundBins($: Engine) {
  return read($, binsAtom)
}

/** Which delegate CLIs are installed, as bin/delegate.py finds them: a button whose CLI is missing is hidden. */
export async function checkBins($: Engine) {
  const s = await cfg($)
  const explicit: Record<DelegateTool, string> = { codex: s.paths.codexBin, agent: s.paths.agentBin, agy: s.paths.agyBin }
  const found: Partial<Record<DelegateTool, string | null>> = {}
  for (const tool of DELEGATE_TOOLS) {
    if (!s.delegates.some(t => t.enabled && t.tool === tool)) continue
    try {
      const ran = await $.process.run(
        [await resolveBin($, 'python3'), `${$.plugin.root}/bin/delegate.py`, 'check', '--tool', tool, '--format', 'json', ...(explicit[tool] ? ['--bin', explicit[tool]] : [])],
        { timeoutMs: 15_000 },
      )
      const o = asRecord((() => { try { return JSON.parse(ran.stdout) as unknown } catch { return null } })())
      const path = typeof o.path === 'string' && o.path ? o.path : typeof o.bin === 'string' && o.bin ? o.bin : null
      const isFound = typeof o.found === 'boolean' ? o.found : path !== null ? true : ran.exitCode === 0
      // Unknown (python missing, an unexpected answer) shows the button: delegate.py reports exit 3 itself.
      if (ran.exitCode !== 0 && typeof o.found !== 'boolean' && path === null && ran.exitCode !== 3) continue
      found[tool] = isFound ? (path ?? tool) : null
    } catch {
      // Leave it unknown.
    }
  }
  await update($, binsAtom, () => found)
}

const binsAtom = atom({ plugin: 'deckhand', key: 'bins' } as const, {} as Partial<Record<DelegateTool, string | null>>)

export const ASSISTS = ['translate', 'search'] as const

export type Assist = (typeof ASSISTS)[number]

/** The delegate a translation or a web search goes to: the chosen slot. */
export const assistTarget = (s: Settings, kind: Assist) =>
  s.delegates[s[kind].slot] ?? s.delegates[kind === 'translate' ? DEFAULT_TRANSLATE_SLOT : DEFAULT_SEARCH_SLOT]!

const ASSIST_TOOLS: Record<Assist, { description: string; inputSchema: Record<string, unknown> }> = {
  translate: {
    description:
      'Translate or localize text (i18n JSON/TS strings, Markdown docs, UI and marketing copy) with the delegate model the user chose in the Deckhand settings (Codex, Cursor agent or agy, read-only). ' +
      'The prompt enforces a localization standard: the idiomatic wording native speakers use in software and web products, never literal dictionary senses ' +
      '(e.g. "fresh" → 全新/最新, not 新鮮), Taiwan vocabulary for zh-TW, and placeholders, code, URLs and markup kept intact. ' +
      'Review the output before using it. Never pass secrets, .env content, tokens or customer data.',
    inputSchema: TRANSLATE_SCHEMA as unknown as Record<string, unknown>,
  },
  search: {
    description:
      'Research a question on the web with the delegate model the user chose in the Deckhand settings (Codex, Cursor agent or agy; read-only, web search on). ' +
      'It answers with a short conclusion, key points and the source URL of each. Use it instead of running many web searches yourself, ' +
      'then check the sources your answer depends on before relying on them. Never pass secrets, .env content, tokens or customer data.',
    inputSchema: SEARCH_SCHEMA as unknown as Record<string, unknown>,
  },
}

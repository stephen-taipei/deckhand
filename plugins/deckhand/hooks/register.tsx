import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { AccountLimits, CodexThread, DelegateTool, EngineLimit, Locale, RecapState, SettingsView, Watch } from '../types'
import { ago, parseChecked, parseWritten, pastePrompt, stateLine, threadsArgv, unfence } from './codex'
import { assistArgv, delegatePrompt, findTarget, SEARCH_MINUTES, targetLabel, TOOL_NAME, TRANSLATE_MINUTES } from './delegate'
import { fingerprintBody, headerOf } from './fingerprint'
import { blockingWait, normalizeOutput, recordStrike, statusKey, stripAttribution } from './guard'
import type { Strike } from './guard'
import { LANGUAGE_NAME, LOCALES, messages, resolveLocale } from './i18n'
import type { Messages } from './i18n'
import {
  DEFAULT_SEARCH_SLOT,
  DEFAULT_TRANSLATE_SLOT,
  defaultSettings,
  DELEGATE_EFFORTS,
  DELEGATE_TOOLS,
  fieldOf,
  normalizeSettings,
  SUB5_EFFORTS,
  SUB5_MODELS,
  withField,
} from './settings'
import type { DelegateTarget, Settings } from './settings'
import { errorText, noteForModel } from './state'
import { SUB5_AGENT, sub5Prompt, workerSpec } from './sub5'
import { buildSearchPrompt, SEARCH_SCHEMA } from './search'
import type { SearchInput } from './search'
import { buildPrompt, cleanOutput, findSecret, TRANSLATE_SCHEMA } from './translate'
import type { TranslateInput } from './translate'
import {
  describeSources,
  effortLevel,
  MODEL_BUTTONS,
  modelFamily,
  parseAccountUsage,
  planSwitch,
  scopedFamily,
  shownPercent,
  usageSegments,
} from './usage'
import type { Family, Segment } from './usage'
import { advance, describeWatch, errorResult, ghArgs, newWatch, notice, parseTarget, prResult, runResult, urlResult } from './watch'
import type { CheckResult, PrView, RunItem, WatchSettings } from './watch'

type Engine = EngineInterface

const WATCH_TOOL = 'mcp__deckhand__watch_deploy'
const TRANSLATE_TOOL = 'mcp__deckhand__translate'
const SEARCH_TOOL = 'mcp__deckhand__search'
const CODEX_PANE = 'deckhand-codex'
const SETTINGS_PANE = 'deckhand-settings'
const RECAP_PANE = 'deckhand-recap'

const text = (value: unknown) => (typeof value === 'string' ? value : '')

const watchesAtom = atom({ plugin: 'deckhand', key: 'watches' } as const, [] as Watch[])
const bandHiddenAtom = atom({ plugin: 'deckhand', key: 'isBandHidden' } as const, false)
const codexThreadsAtom = atom({ plugin: 'deckhand', key: 'codexThreads' } as const, [] as CodexThread[])
const codexErrorAtom = atom({ plugin: 'deckhand', key: 'codexError' } as const, null as string | null)
const codexLoadingAtom = atom({ plugin: 'deckhand', key: 'isCodexLoading' } as const, false)
const codexAllAtom = atom({ plugin: 'deckhand', key: 'codexAllProjects' } as const, false)
const engineLimitsAtom = atom({ plugin: 'deckhand', key: 'engineLimits' } as const, [] as EngineLimit[])
const accountLimitsAtom = atom({ plugin: 'deckhand', key: 'accountLimits' } as const, null as AccountLimits | null)
const contextPercentAtom = atom({ plugin: 'deckhand', key: 'contextPercent' } as const, null as number | null)
const contextTokensAtom = atom({ plugin: 'deckhand', key: 'contextTokens' } as const, null as number | null)
const modelAtom = atom({ plugin: 'deckhand', key: 'model' } as const, '')
const effortAtom = atom({ plugin: 'deckhand', key: 'effort' } as const, null as string | null)
const settingsAtom = atom({ plugin: 'deckhand', key: 'settings' } as const, null as Settings | null)
const localeAtom = atom({ plugin: 'deckhand', key: 'locale' } as const, 'en' as Locale)
const recapAtom = atom({ plugin: 'deckhand', key: 'recap' } as const, { status: 'idle', text: '', at: 0 } as RecapState)
const settingsViewAtom = atom({ plugin: 'deckhand', key: 'settingsView' } as const, { tab: 'general', editing: -1, isResetArmed: false } as SettingsView)
const binsAtom = atom({ plugin: 'deckhand', key: 'bins' } as const, {} as Partial<Record<DelegateTool, string | null>>)
const knownScopedAtom = atom({ plugin: 'deckhand', key: 'knownScoped' } as const, [] as string[])

/** Timers of running watches; module state, re-armed from `$.state` after a reload. */
const timers = new Map<string, Timer>()

/** Absolute paths of CLIs: the desktop app's PATH may lack ~/.local/bin or Homebrew. */
const bins = new Map<string, string>()

async function resolveBin($: Engine, name: string) {
  const known = bins.get(name)
  if (known) return known
  let found = name
  try {
    const home = (await $.env.get('HOME')) ?? ''
    for (const dir of [`${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
      if (await $.fs.exists(`${dir}/${name}`)) {
        found = `${dir}/${name}`
        break
      }
    }
  } catch {
    // No fs or env here (tests): fall back to PATH lookup.
  }
  bins.set(name, found)
  return found
}

// ── Settings and language ───────────────────────────────────────────────────

const asRecord = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/**
 * The person's settings from `$.store`, read against defaults that depend on their Claude settings
 * (the attribution guard), and the language they resolve to. Called at session start and on demand.
 */
async function loadSettings($: Engine): Promise<Settings> {
  const claude = asRecord(await $.settings.read().catch(() => ({})))
  const base = defaultSettings({ attributionOff: asRecord(claude.attribution).commit === '' })
  const stored = await $.store.get('settings').catch(() => undefined)
  const s = normalizeSettings(stored, base, LOCALES)
  await update($, settingsAtom, () => s)
  await update($, localeAtom, () => resolveLocale(s.language, claude.language))
  const known = await $.store.get('knownScoped').catch(() => undefined)
  if (Array.isArray(known)) await update($, knownScopedAtom, () => known.filter((k): k is string => typeof k === 'string'))
  return s
}

async function cfg($: Engine): Promise<Settings> {
  return (await read($, settingsAtom)) ?? loadSettings($)
}

/** For drawing: reads only (a render hook may not write state); defaults until the session has loaded them. */
async function cfgForDrawing($: Engine): Promise<Settings> {
  return (await read($, settingsAtom)) ?? defaultSettings({ attributionOff: false })
}

/** The catalog for a handler: loads the settings first when the session has not, so the language is right. */
async function msgs($: Engine): Promise<Messages> {
  if (!(await read($, settingsAtom))) await loadSettings($)
  return messages(await read($, localeAtom))
}

/** The catalog for drawing: reads only. */
async function msgsForDrawing($: Engine): Promise<Messages> {
  return messages(await read($, localeAtom))
}

const watchSettingsOf = (s: Settings): WatchSettings => ({
  baseMs: s.watch.pollSeconds * 1000,
  // A watch that stops after one look watches nothing: at least two identical results.
  limit: Math.max(2, s.guards.repeatLimit),
  stallMs: s.watch.stallMinutes * 60_000,
})

/** Saves settings, then redoes what depends on them: the language, the commands, the worker, the CLIs. */
async function commitSettings($: Engine, next: Settings) {
  const before = await cfg($)
  await update($, settingsAtom, () => next)
  await $.store.set('settings', next).catch(error => $.ui.log(`deckhand: settings not saved (${errorText(error)})`))
  const claude = asRecord(await $.settings.read().catch(() => ({})))
  await update($, localeAtom, () => resolveLocale(next.language, claude.language))
  const m = await msgs($)
  if (before.language !== next.language) await registerCommands($, m, next).catch(error => $.ui.log(`deckhand: commands not registered (${errorText(error)})`))
  if (before.language !== next.language || JSON.stringify(before.sub5) !== JSON.stringify(next.sub5) || before.guards.attribution !== next.guards.attribution) {
    await registerWorker($, m, next)
  }
  if (JSON.stringify(before.paths) !== JSON.stringify(next.paths) || JSON.stringify(before.delegates) !== JSON.stringify(next.delegates)) {
    void checkBins($).catch(() => undefined)
  }
  for (const kind of ASSISTS) {
    if (next[kind].enabled && !before[kind].enabled) {
      await registerAssist($, next, kind).catch(error => $.ui.log(`deckhand: ${kind} tool not registered (${errorText(error)})`))
    }
  }
}

// ── Translate and search: work handed to a delegate, off until the person turns it on ──

const ASSISTS = ['translate', 'search'] as const
type Assist = (typeof ASSISTS)[number]

/** The delegate a translation or a web search goes to: the chosen slot. */
const assistTarget = (s: Settings, kind: Assist) =>
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

/**
 * A translate or search tool exists only once the person turns it on: with it off, the main model
 * never sees it. There is no unregistering, so turning it off mid-session leaves it refusing calls.
 */
async function registerAssist($: Engine, s: Settings, kind: Assist) {
  if (!s[kind].enabled) return
  await $.tool.register({ name: kind, ...ASSIST_TOOLS[kind] })
}

/**
 * Runs one translation or web search through delegate.py (the chosen CLI, read-only, secrets checked
 * again; `--raw`: the prompt is whole and stdout is the answer alone) and answers the tool call.
 */
async function runAssist($: Engine, kind: Assist, prompt: string, clean: (stdout: string) => string) {
  const m = await msgs($)
  const s = await cfg($)
  const words = m[kind]
  const target = assistTarget(s, kind)
  const who = `${target.key} · ${targetLabel(target, m)}`
  const explicit: Record<DelegateTool, string> = { codex: s.paths.codexBin, agent: s.paths.agentBin, agy: s.paths.agyBin }
  const minutes = kind === 'search' ? SEARCH_MINUTES : TRANSLATE_MINUTES
  try {
    const ran = await $.process.run(
      assistArgv({
        python: await resolveBin($, 'python3'),
        tool: `${$.plugin.root}/bin/delegate.py`,
        target,
        locale: await read($, localeAtom),
        bin: explicit[target.tool] || undefined,
        codexHome: s.paths.codexHome || undefined,
        minutes,
        web: kind === 'search',
      }),
      { stdin: prompt, timeoutMs: minutes * 60_000 + 30_000 },
    )
    const out = clean(ran.stdout)
    if (ran.exitCode !== 0 || !out) {
      const why = (ran.stderr || ran.stdout).trim().split('\n').slice(-3).join(' ') || `exit ${ran.exitCode}`
      return { deny: words.failed(who, why) }
    }
    return { result: `${out}\n\n---\n${words.footer(who)}` }
  } catch (error) {
    return { deny: words.cannotRun(who, errorText(error)) }
  }
}

/** One edit from the ⚙ pane: kept when it survives the checks, else the old value stays and the person is told. */
async function saveField($: Engine, field: string, value: unknown, label: string) {
  const m = await msgs($)
  const s = await cfg($)
  const next = normalizeSettings(withField(s, field, value), s, LOCALES)
  const before = fieldOf(s, field)
  const after = fieldOf(next, field)
  const isRefused = String(after) === String(before) && String(value).trim().toLowerCase() !== String(before).toLowerCase()
  if (isRefused) {
    $.ui.toast(m.settings.invalid(label))
    return
  }
  await commitSettings($, next)
  // Read the catalog again: the edit may have been the language itself.
  $.ui.toast((await msgs($)).settings.saved, { timeoutMs: 2_000 })
}

async function registerCommands($: Engine, m: Messages, s: Settings) {
  const rule = m.watch.stopRule(watchSettingsOf(s).limit, s.watch.stallMinutes)
  const keys = s.delegates.filter(t => t.enabled).map(t => t.key).join('|')
  await $.command.register({ name: 'watch-deploy', description: m.watch.commandDescription(rule), argumentHint: m.watch.commandHint })
  await $.command.register({ name: 'handoff', description: m.codex.handoffDescription, argumentHint: m.codex.handoffHint })
  await $.command.register({ name: 'codex', description: m.codex.codexDescription, argumentHint: m.codex.codexHint })
  await $.command.register({ name: 'codex-latest', description: m.codex.latestDescription })
  await $.command.register({ name: 'handoff-in', description: m.codex.handoffInDescription })
  await $.command.register({ name: 'sub5', description: m.sub5.commandDescription(s.sub5.max), argumentHint: m.sub5.commandHint })
  await $.command.register({ name: 'delegate', description: m.delegate.commandDescription(keys.replace(/\|/g, '/')), argumentHint: m.delegate.commandHint(keys) })
  await $.command.register({ name: 'usage-raw', description: m.usage.rawCommand })
  await $.command.register({ name: 'deckhand', description: m.settings.commandDescription })
}

async function registerWorker($: Engine, m: Messages, s: Settings) {
  await $.agent
    .register(workerSpec({ model: s.sub5.model, effort: s.sub5.effort, languageName: m.languageName, attribution: s.guards.attribution }))
    .catch(error => $.ui.log(`deckhand: ${SUB5_AGENT} not registered (${errorText(error)})`))
}

/** Which delegate CLIs are installed, as bin/delegate.py finds them: a button whose CLI is missing is hidden. */
async function checkBins($: Engine) {
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

// ── Deploy watch: the engine side ───────────────────────────────────────────

async function checkWatch($: Engine, w: Watch, m: Messages): Promise<CheckResult> {
  try {
    if (w.kind === 'url') {
      const res = await $.http.fetch(w.target, { headers: { 'cache-control': 'no-cache' } })
      // The content decides, not etag or last-modified: nodes of one CDN disagree on those.
      return urlResult(w, res.status, fingerprintBody(headerOf(res.headers, 'content-type'), res.text), res.text, m)
    }
    const ran = await $.process.run([await resolveBin($, 'gh'), ...ghArgs(w), ...(w.repo ? ['--repo', w.repo] : [])], {
      cwd: w.cwd,
      timeoutMs: 60_000,
    })
    if (ran.exitCode !== 0) {
      return errorResult(((ran.stderr || ran.stdout).trim().split('\n')[0] ?? '').slice(0, 160) || `gh exited ${ran.exitCode}`, m)
    }
    const json = JSON.parse(ran.stdout) as unknown
    if (w.kind === 'pr') return prResult(json as PrView, m)
    return runResult(Array.isArray(json) ? (json as RunItem[]) : [json as RunItem], m)
  } catch (error) {
    return errorResult(errorText(error).slice(0, 160), m)
  }
}

function schedule($: Engine, w: Watch, s: WatchSettings) {
  timers.get(w.id)?.cancel()
  timers.delete(w.id)
  if (w.status !== 'watching') return
  timers.set(
    w.id,
    $.clock.after(Math.max(1000, w.intervalMs), () => void runCheck($, w.id).catch(() => undefined)),
  )
}

async function runCheck($: Engine, id: string): Promise<Watch | undefined> {
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
    $.ui.toast(toast, { timeoutMs: 15_000 })
    await $.session.append(noteForModel(note)).catch(() => undefined)
    if (next.status === 'done' && result.followUp) {
      await startWatch($, result.followUp, { startedBy: current.startedBy, repo: current.repo })
    }
  }
  return next
}

async function startWatch(
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
  const watch = newWatch(t, `${t.kind}-${now.toString(36)}`, await $.session.cwd(), now, watchSettingsOf(await cfg($)), {
    expect: options.expect || undefined,
    startedBy: options.startedBy,
  }, m)
  await update($, bandHiddenAtom, () => false)
  await update($, watchesAtom, list => [...list.slice(-7), watch])
  return (await runCheck($, watch.id)) ?? watch
}

async function stopWatches($: Engine, which: string) {
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

async function clearFinished($: Engine) {
  await update($, watchesAtom, list => list.filter(w => w.status === 'watching'))
}

async function resumeWatches($: Engine) {
  const now = await $.clock.now()
  const s = watchSettingsOf(await cfg($))
  for (const w of await read($, watchesAtom)) {
    if (w.status === 'watching') schedule($, { ...w, intervalMs: Math.max(1000, w.nextAt - now) }, s)
  }
}

// ── Codex inbox and handoff ─────────────────────────────────────────────────

async function loadCodexThreads($: Engine): Promise<CodexThread[]> {
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
async function handoffTool($: Engine, args: string[], stdin?: string) {
  const locale = await read($, localeAtom)
  return $.process.run(
    [await resolveBin($, 'python3'), `${$.plugin.root}/bin/handoff-state.py`, ...args, '--cwd', await $.session.cwd(), '--lang', locale],
    { stdin, timeoutMs: 60_000 },
  )
}

const lastLine = (output: string) => output.trim().split('\n').pop() ?? ''

/**
 * Keeps ~/.agent-handoff/bin/handoff-state.py equal to the plugin's copy: Codex's AGENTS.md names that
 * path, so it must not go stale when the plugin is updated. The folder is made private (700) when new.
 * Its sibling i18n.py goes along, since the tool imports it.
 */
async function syncSharedTool($: Engine) {
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

// ── Usage readout ───────────────────────────────────────────────────────────

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/** The account's usage is asked for at most this often; after a failure, not before the backoff. */
const ACCOUNT_MIN_MS = 5 * 60_000
const ACCOUNT_BACKOFF_MS = 15 * 60_000
let lastAccountTry = 0
let accountBackoffUntil = 0
let accountWarned = false

type Measured = {
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  context: { percent?: number; tokens?: number }
}

async function storeUsage($: Engine, m: Measured) {
  await update($, engineLimitsAtom, () => m.rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt })))
  await update($, contextPercentAtom, () => m.context.percent ?? null)
  await update($, contextTokensAtom, () => m.context.tokens ?? null)
}

async function refreshModel($: Engine) {
  const model = await $.session.model().catch(() => '')
  if (model) await update($, modelAtom, () => model)
}

/**
 * The weekly windows are nowhere in the engine's figures, so the account's own usage is asked for,
 * through the engine: it holds the credential and sets the header, the plugin never sees the secret.
 * Rare on purpose; a failure keeps the last good reading and backs off.
 */
async function refreshAccountUsage($: Engine, force = false) {
  const now = await $.clock.now()
  if (!force && (now - lastAccountTry < ACCOUNT_MIN_MS || now < accountBackoffUntil)) return
  lastAccountTry = now
  const fail = async (status: string) => {
    accountBackoffUntil = now + ACCOUNT_BACKOFF_MS
    const current = await read($, accountLimitsAtom)
    if (current && current.status === 'ok') return
    await update($, accountLimitsAtom, () => ({ windows: [], fetchedAt: now, status }))
    // 7d has no other source: say once per session why it reads – (no credential is no news: an API key has no plan limits).
    if (status !== 'no-credential' && !accountWarned) {
      accountWarned = true
      $.ui.toast((await msgs($)).usage.unreadable(status), { timeoutMs: 12_000 })
    }
  }
  try {
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') return await fail('no-credential')
    const res = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (!res.ok) return await fail(`http-${res.status}`)
    const parsed = parseAccountUsage(JSON.parse(res.text), now, 'ok', res.text.slice(0, 1500))
    if (!parsed) return await fail('no-windows')
    accountBackoffUntil = 0
    await update($, accountLimitsAtom, () => parsed)
    // Remember which model windows this account has, so they read – (not vanish) while unreadable.
    const families = [...new Set(parsed.windows.map(scopedFamily).filter((f): f is string => f !== null))]
    const known = await read($, knownScopedAtom)
    if (families.some(f => !known.includes(f))) {
      const merged = [...new Set([...known, ...families])]
      await update($, knownScopedAtom, () => merged)
      await $.store.set('knownScoped', merged).catch(() => undefined)
    }
  } catch (error) {
    await fail(`error: ${errorText(error).slice(0, 80)}`)
  }
}

async function loadUsage($: Engine) {
  await storeUsage($, await $.session.usage())
}

async function currentSegments($: Engine, warnAt: number, withContext: boolean): Promise<Segment[]> {
  return usageSegments({
    engine: await read($, engineLimitsAtom),
    account: await read($, accountLimitsAtom),
    contextPercent: withContext ? await read($, contextPercentAtom) : null,
    now: await $.clock.now(),
    warnAt,
    knownScoped: await read($, knownScopedAtom),
  })
}

const limitName = (s: Segment, m: Messages) =>
  s.id === 'fiveHour' ? m.usage.fiveHour : s.id === 'weekly' ? m.usage.weekly : m.usage.scoped(s.name ?? s.id)

/** One toast per limit and level, for the highest level crossed; it speaks again after the window resets. */
async function warnWhenHigh($: Engine, warned: Set<string>) {
  const warnAt = (await cfg($)).usage.warnPercent
  const m = await msgs($)
  for (const s of await currentSegments($, warnAt, false)) {
    if (s.percent === null) continue
    const crossed = [95, warnAt].find(level => s.percent! >= level)
    if (crossed === undefined) continue
    const key = `${s.id}@${crossed}@${s.resetsAt ?? ''}`
    if (warned.has(key)) continue
    warned.add(key)
    if (crossed === 95) warned.add(`${s.id}@${warnAt}@${s.resetsAt ?? ''}`)
    const reset = s.resetsAt ? m.usage.resets(s.resetsAt.slice(11, 16)) : ''
    $.ui.toast(m.usage.warn(limitName(s, m), shownPercent(s.percent), reset), { timeoutMs: 20_000 })
  }
}

// ── Model buttons ───────────────────────────────────────────────────────────

/** A /model the desktop app is about to send for the person: the effort to put back once it ran. */
let pendingSwitch: { alias: string; level: string | null; at: number } | null = null

/**
 * A click on O / F / S / H.
 *
 * The desktop app owns the session's model: it applies its own menu's pick to every turn, and its menu
 * follows only a /model the person sends. A switch made behind its back is undone on the next turn,
 * and no plugin call reaches its menu. So there the button writes `/model <family>` into the prompt
 * box and the person presses Enter: the app's own path, menu included.
 *
 * Elsewhere (the terminal) the engine owns the model: `/model <family>` runs at once, then the effort
 * the last turn ran at is put back, because switching models otherwise loads the new model's own level.
 */
async function pressModel($: Engine, family: Family, isWorking: boolean, surface: string) {
  const m = await msgs($)
  const current = await $.session.model().catch(() => '')
  const plan = planSwitch(current, family, await read($, contextTokensAtom), m)
  if (!plan.ok) {
    $.ui.toast(plan.reason)
    return
  }
  const name = MODEL_BUTTONS.find(b => b.family === family)!.name
  if (surface === 'desktop') {
    const command = `/model ${plan.alias}`
    const box = await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))
    if (box.text.trim() && !/^\/model\b/.test(box.text.trim())) {
      $.ui.toast(m.model.boxBusy)
      return
    }
    const filled = await $.prompt.fill({ text: command, mode: 'replace' }).catch(() => ({ isFilled: false }))
    if (filled.isFilled) pendingSwitch = { alias: plan.alias, level: plan.keepEffort ? await read($, effortAtom) : null, at: await $.clock.now() }
    $.ui.toast(filled.isFilled ? m.model.fillReady(name, command) : m.model.fillFailed(command), { timeoutMs: 12_000 })
    return
  }
  if (isWorking) {
    $.ui.toast(m.model.busy)
    return
  }
  const level = plan.keepEffort ? await read($, effortAtom) : null
  let after = current
  let said = ''
  for (const alias of plan.alias === family ? [family] : [plan.alias, family]) {
    try {
      said = (await $.command.run({ command: 'model', args: alias })).text ?? said
    } catch (error) {
      said = errorText(error)
    }
    after = await $.session.model()
    if (modelFamily(after) === family) break
  }
  await update($, modelAtom, () => after)
  if (modelFamily(after) !== family) {
    $.ui.toast(m.model.failed(said))
    return
  }
  $.ui.toast(m.model.switched(after, level ? await restoreEffort($, level, m) : ''))
}

/** Puts the effort back; says so when this version has no /effort, instead of claiming it was kept. */
async function restoreEffort($: Engine, level: string, m: Messages) {
  try {
    const commands = await $.command.list()
    if (!commands.some(c => c.name === 'effort')) throw new Error(m.model.noEffortCommand)
    await $.command.run({ command: 'effort', args: level })
    return m.model.effortKept(level)
  } catch (error) {
    return m.model.effortNotKept(level, errorText(error))
  }
}

// ── Sub5 ────────────────────────────────────────────────────────────────────

let lastSub5At = 0

/** The Sub5 button and `/sub5`: hands the main agent the flow as the user's own instruction. */
async function startSub5($: Engine, note: string, isWorking: boolean) {
  const m = await msgs($)
  const s = await cfg($)
  const now = await $.clock.now()
  if (now - lastSub5At < 8_000) {
    $.ui.toast(m.sub5.guard)
    return false
  }
  lastSub5At = now
  $.ui.toast(isWorking ? m.sub5.queued : m.sub5.sent, { timeoutMs: 8_000 })
  try {
    const brief = sub5Prompt(
      { ...s.sub5, tool: `${$.plugin.root}/bin/sub5.py`, note, locale: await read($, localeAtom), attribution: s.guards.attribution },
      m,
    )
    await $.prompt.submit({ text: brief, asUser: true })
  } catch (error) {
    lastSub5At = 0
    $.ui.toast(m.sub5.failed(errorText(error)))
    return false
  }
  return true
}

// ── Delegate ────────────────────────────────────────────────────────────────

let lastDelegateAt = 0

/**
 * A delegate button, or `/delegate`: hands the main agent one delegation to an outside model, as the
 * user's own instruction. The task is `task` when one is given, else (`useDraft`) the draft in the
 * prompt box, else the conversation's current work. This never touches the main agent's model or effort.
 */
async function startDelegate($: Engine, target: DelegateTarget, task: string, isWorking: boolean, useDraft: boolean) {
  const m = await msgs($)
  const s = await cfg($)
  const now = await $.clock.now()
  if (now - lastDelegateAt < 8_000) {
    $.ui.toast(m.delegate.guard)
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
  $.ui.toast(isWorking ? m.delegate.queued(target.key, label, source) : m.delegate.sent(target.key, label, source), { timeoutMs: 10_000 })
  const explicit: Record<DelegateTool, string> = { codex: s.paths.codexBin, agent: s.paths.agentBin, agy: s.paths.agyBin }
  try {
    const brief = delegatePrompt(
      {
        tool: `${$.plugin.root}/bin/delegate.py`,
        target,
        locale: await read($, localeAtom),
        bin: explicit[target.tool] || undefined,
        codexHome: s.paths.codexHome || undefined,
        task: taskText,
        attribution: s.guards.attribution,
      },
      m,
    )
    await $.prompt.submit({ text: brief, asUser: true })
  } catch (error) {
    lastDelegateAt = 0
    if (draft) await $.prompt.fill({ text: draft }).catch(() => undefined)
    $.ui.toast(m.delegate.failed(target.key, errorText(error)))
    return false
  }
  return true
}

// ── Recap ───────────────────────────────────────────────────────────────────

let isRecapRunning = false

/**
 * The recap button: a fork of the conversation retells it in plain words, shown in a pane. The fork
 * reads the whole context but adds nothing to it: the conversation stays as it was.
 */
async function startRecap($: Engine) {
  const m = await msgs($)
  await $.ui.open({ id: RECAP_PANE, title: m.recap.paneTitle })
  if (isRecapRunning) {
    $.ui.toast(m.recap.guard)
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

async function openSettings($: Engine) {
  const m = await msgs($)
  await $.ui.open({ id: SETTINGS_PANE, title: m.settings.title, focus: true })
}

// ── Routing: what the model is told about the plugin ────────────────────────

const who = (t: DelegateTarget) => `${t.key}: ${TOOL_NAME[t.tool]} · ${t.name}`

const routing = (s: Settings) =>
  [
    "Deckhand (the user's Claude Code plugin):",
    `- To wait for a PR, CI run, merge or deploy, call ${WATCH_TOOL} once and end your turn. Never poll with sleep loops, \`gh run watch\`, \`gh pr checks --watch\` or repeated gh/curl status checks; the plugin polls locally, stops itself after repeated identical results and notifies the user.`,
    ...(s.translate.enabled
      ? [
          `- To translate i18n strings, docs or copy, call ${TRANSLATE_TOOL} (${who(assistTarget(s, 'translate'))}, localized-wording standard), then review terms and format before using the result. Never put secrets in it.`,
        ]
      : []),
    ...(s.search.enabled
      ? [
          `- For web research (docs, versions, prices, recent changes), call ${SEARCH_TOOL} (${who(assistTarget(s, 'search'))}) instead of running many searches yourself, then check the sources your answer depends on. Never put secrets in it.`,
        ]
      : []),
    ...(s.guards.attribution ? ['- Commit messages and PR descriptions carry no Co-Authored-By trailer and no "Generated with Claude Code" footer.'] : []),
  ].join('\n')

// ── Hooks ───────────────────────────────────────────────────────────────────

export const register: Register = on => {
  const strikes = new Map<string, Strike>()
  const warned = new Set<string>()

  on('session.start', async ($, e, next) => {
    const s = await loadSettings($)
    const m = await msgs($)
    await registerCommands($, m, s)
    await registerWorker($, m, s)
    await $.tool.register({
      name: 'watch_deploy',
      description:
        'Watch a GitHub PR, an Actions run, all CI runs of a commit, or a deployed URL in the background, without spending tokens. ' +
        'Use this INSTEAD of sleep/poll loops, `gh run watch`, `gh pr checks --watch` or repeated gh/curl status checks. ' +
        'target: "#128", "run:123", "sha:<commit>", a GitHub PR or Actions run URL, or an https URL. ' +
        'expect (URL only, strongly recommended): text whose appearance means the new version is live (a commit sha, a version string). ' +
        'Without it the watch compares the page itself and needs two checks to confirm a change. ' +
        'Returns the current state at once. When the watch finishes, or stops after repeated identical results, the user gets a toast and a [deckhand] note is added to this conversation. ' +
        "A merged PR automatically continues as a watch of its merge commit's CI runs. After calling it, end your turn instead of polling.",
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'PR / run / commit / URL to watch.' },
          expect: { type: 'string', description: 'For a URL: text that proves the new deploy is live.' },
        },
        required: ['target'],
      },
    })
    for (const kind of ASSISTS) await registerAssist($, s, kind)
    // The usage readout lives in the band above the prompt: no status line.
    $.ui.status(undefined)
    await syncSharedTool($)
    await resumeWatches($)
    await loadUsage($).catch(() => undefined)
    await refreshModel($)
    void refreshAccountUsage($, true).catch(() => undefined)
    void checkBins($).catch(() => undefined)
    return next(e)
  })

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
    const watch = await startWatch($, target, { expect: text(args.expect).trim(), startedBy: 'model' })
    if (typeof watch === 'string') return { deny: watch }
    const s = await cfg($)
    const tail = watch.status === 'watching' ? m.watch.toolWatching(m.watch.stopRule(watchSettingsOf(s).limit, s.watch.stallMinutes)) : m.watch.toolFinished
    return { result: `${describeWatch(watch, m)}\n${tail}` }
  }).catch(async ($, _e, next) => ({ deny: (await msgs($)).watch.toolError(errorText(next.error)) }))

  // The band above the prompt: the running watches, then the control row: the usage readout, the model
  // buttons, Sub5, the delegates, the recap, a tip slot that takes the free width, and ⚙ at the right end.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await msgsForDrawing($)
    const s = await cfgForDrawing($)
    const watches = await read($, watchesAtom)
    const hasWatches = watches.length > 0 && !(await read($, bandHiddenAtom))
    const hasFinished = watches.some(w => w.status !== 'watching')
    const segments = s.show.usage ? await currentSegments($, s.usage.warnPercent, true) : []
    const family = modelFamily(await read($, modelAtom))
    const found = await read($, binsAtom)
    const isWorking = e.props.isWorking
    const isDesktop = e.surface === 'desktop'
    // A target whose CLI is known to be missing has no button; an unchecked one keeps it.
    const targets = s.show.delegates ? s.delegates.filter(t => t.enabled && found[t.tool] !== null) : []
    const scope = (id: string) => `deckhand-tip-${id}`
    const tips = [
      ...(segments.length ? [{ id: 'usage', text: m.tips.usage }] : []),
      ...(s.show.models ? MODEL_BUTTONS.map(b => ({ id: `m-${b.key}`, text: isDesktop ? m.tips.modelDesktop(b.name) : m.tips.model(b.name) })) : []),
      ...(s.show.sub5 ? [{ id: 'sub5', text: m.tips.sub5(s.sub5.max) }] : []),
      ...targets.map(t => ({ id: `d-${t.key}`, text: m.tips.delegate(targetLabel(t, m)) })),
      ...(s.show.recap ? [{ id: 'recap', text: m.tips.recap }] : []),
      { id: 'gear', text: m.tips.settings },
    ]
    return (
      <Box flexDirection="column">
        {hasWatches &&
          watches.slice(-4).map(w => (
            <Box key={`w-${w.id}`} gap={1}>
              <Text color={w.status === 'done' ? 'green' : w.status === 'stopped' ? 'yellow' : undefined}>
                {w.status === 'watching' ? '⏳' : w.status === 'done' ? '✅' : '⏹'} {w.label}
              </Text>
              <Text dimColor wrap="truncate">
                {w.reason ?? w.summary}
                {w.status === 'watching' ? m.watch.checkCount(w.checks) : ''}
              </Text>
              {w.status === 'watching' && <Button key={`stop-${w.id}`} label={m.watch.stop} onPress={() => void stopWatches($, w.id)} />}
            </Box>
          ))}
        {hasWatches && (
          <Box gap={1}>
            {hasFinished && <Button key="clear" label={m.watch.clearDone} onPress={() => void clearFinished($)} />}
            <Button key="hide" label={m.watch.hide} onPress={() => void update($, bandHiddenAtom, () => true)} />
          </Box>
        )}
        <Box gap={1} flexWrap="wrap">
          {segments.map((seg, i) => (
            <Text
              key={`u-${seg.id}`}
              color={seg.level === 'high' ? 'red' : seg.level === 'warn' ? 'yellow' : undefined}
              dimColor={seg.level === 'ok' || seg.level === 'unknown'}
              hover={{ scope: scope('usage') }}
            >
              {seg.text}
              {i < segments.length - 1 ? ' ·' : ''}
            </Text>
          ))}
          {s.show.models &&
            MODEL_BUTTONS.map(b => (
              <Button
                key={`m-${b.key}`}
                label={b.key}
                variant={family === b.family ? 'primary' : 'secondary'}
                dimColor={family !== b.family}
                hover={{ scope: scope(`m-${b.key}`) }}
                onPress={press => void pressModel($, b.family, isWorking, press.surface)}
              />
            ))}
          {s.show.sub5 && (
            <Button key="sub5" label="Sub5" variant="secondary" hover={{ scope: scope('sub5') }} onPress={() => void startSub5($, '', isWorking)} />
          )}
          {targets.map(t => (
            <Button
              key={`d-${t.key}`}
              label={t.key}
              variant="secondary"
              hover={{ scope: scope(`d-${t.key}`) }}
              onPress={() => void startDelegate($, t, '', isWorking, true)}
            />
          ))}
          {s.show.recap && (
            <Button key="recap" label={m.recap.label} variant="secondary" hover={{ scope: scope('recap') }} onPress={() => void startRecap($)} />
          )}
          <Box key="tips" flexGrow={1} minWidth={1}>
            {tips.map(t => (
              <Box
                key={`tip-${t.id}`}
                position="absolute"
                top={0}
                left={0}
                width="100%"
                display="none"
                hover={{ display: 'flex', scope: scope(t.id) }}
              >
                <Text key={`tip-text-${t.id}`} dimColor wrap="truncate">
                  {t.text}
                </Text>
              </Box>
            ))}
          </Box>
          <Button key="gear" label="⚙" variant="secondary" hover={{ scope: scope('gear') }} onPress={() => void openSettings($)} />
        </Box>
      </Box>
    )
  })

  // ── Settings pane ───────────────────────────────────────────────────────

  on('command.run', { command: 'deckhand' }, async $ => {
    await openSettings($)
    return { text: (await msgs($)).settings.title }
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // The mobile app draws no field: there the pane shows the values instead of fields.
    const Input = 'Input' in ui ? ui.Input : undefined
    const Select = 'Select' in ui ? ui.Select : undefined
    const m = await msgsForDrawing($)
    const s = await cfgForDrawing($)
    const found = await read($, binsAtom)
    const view = await read($, settingsViewAtom)
    // A label beside its field reads fastest; a narrow pane stacks them.
    const isNarrow = e.props.bodyColumns < 60
    const setView = (patch: (v: SettingsView) => Partial<SettingsView>) =>
      void update($, settingsViewAtom, v => ({ ...v, ...patch(v) })).catch(() => undefined)
    const save = (field: string, value: unknown, label: string) => void saveField($, field, value, label).catch(() => undefined)

    const check = (field: string, value: boolean, label: string) => (
      <Button key={`t-${field}`} label={`${value ? '☑' : '☐'} ${label}`} variant="secondary" onPress={() => save(field, !value, label)} />
    )
    const row = (key: string, label: string, control: RenderElement) => (
      <Box key={`r-${key}`} flexDirection={isNarrow ? 'column' : 'row'} columnGap={2} alignItems={isNarrow ? 'flex-start' : 'center'}>
        <Box width={isNarrow ? undefined : 20} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        {control}
      </Box>
    )
    const field = (key: string, label: string, value: string | number, asNumber = false) =>
      row(
        key,
        label,
        Input ? (
          <Input key={`i-${key}`} value={String(value)} submitLabel={m.settings.save} onSubmit={(v: string) => save(key, asNumber ? Number(v) : v, label)} />
        ) : (
          <Text key={`i-${key}`}>{String(value) || '—'}</Text>
        ),
      )
    const choice = (key: string, label: string, value: string, options: readonly { value: string; label: string }[]) =>
      row(
        key,
        label,
        Select ? (
          <Select key={`s-${key}`} value={value} options={options} onSelect={(v: string) => save(key, v, label)} />
        ) : (
          <Text key={`s-${key}`}>{options.find(o => o.value === value)?.label ?? value}</Text>
        ),
      )
    const plain = (list: readonly string[]) => list.map(v => ({ value: v, label: v }))
    const heading = (key: string, title: string, hint?: string) => (
      <Box key={`h-${key}`} flexDirection="column" marginTop={1}>
        <Text bold>{title}</Text>
        {hint ? <Text dimColor>{hint}</Text> : null}
      </Box>
    )

    const TABS = ['general', 'delegates', 'assist', 'sub5', 'advanced'] as const
    const tabs = (
      <Box key="tabs" gap={1} flexWrap="wrap">
        {TABS.map(t => (
          <Button
            key={`tab-${t}`}
            label={m.settings.tabs[t]}
            variant={view.tab === t ? 'primary' : 'secondary'}
            onPress={() => setView(() => ({ tab: t, editing: -1, isResetArmed: false }))}
          />
        ))}
      </Box>
    )

    const general = (
      <Box key="general" flexDirection="column" gap={1}>
        {choice('language', m.settings.language, s.language, [
          { value: 'auto', label: m.settings.auto },
          ...LOCALES.map(l => ({ value: l, label: LANGUAGE_NAME[l] })),
        ])}
        {heading('buttons', m.settings.buttons, m.settings.buttonsHint)}
        <Box gap={1} flexWrap="wrap">
          {check('show.usage', s.show.usage, m.settings.showUsage)}
          {check('show.models', s.show.models, m.settings.showModels)}
          {check('show.sub5', s.show.sub5, m.settings.showSub5)}
          {check('show.delegates', s.show.delegates, m.settings.showDelegates)}
          {check('show.recap', s.show.recap, m.settings.showRecap)}
        </Box>
        {field('usage.warnPercent', m.settings.warnPercent, s.usage.warnPercent, true)}
      </Box>
    )

    // One line per delegate; Edit opens its fields below it, one delegate at a time.
    const delegates = (
      <Box key="delegates" flexDirection="column" gap={1}>
        {heading('delegates', m.settings.delegates, m.settings.delegatesHint)}
        {s.delegates.map((t, i) => (
          <Box key={`d-${i}`} flexDirection="column" gap={1}>
            {/* The controls come first: the summary after them is what gives way when the pane is narrow. */}
            <Box gap={1} alignItems="center">
              {check(`delegates.${i}.enabled`, t.enabled, t.key)}
              <Button
                key={`edit-${i}`}
                label={view.editing === i ? m.settings.done : m.settings.edit}
                variant={view.editing === i ? 'primary' : 'secondary'}
                onPress={() => setView(v => ({ editing: v.editing === i ? -1 : i }))}
              />
              {found[t.tool] === null ? <Text color="yellow">{m.settings.cliMissing}</Text> : null}
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text dimColor={!t.enabled} wrap="truncate">{`${TOOL_NAME[t.tool]} · ${t.name} · ${t.effort}`}</Text>
              </Box>
            </Box>
            {view.editing === i ? (
              <Box flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
                {field(`delegates.${i}.key`, m.settings.label, t.key)}
                {choice(`delegates.${i}.tool`, m.settings.tool, t.tool, DELEGATE_TOOLS.map(v => ({ value: v, label: TOOL_NAME[v] })))}
                {field(`delegates.${i}.model`, m.settings.modelId, t.model)}
                {choice(`delegates.${i}.effort`, m.settings.effort, t.effort, plain(DELEGATE_EFFORTS))}
                {field(`delegates.${i}.name`, m.settings.name, t.name)}
              </Box>
            ) : null}
          </Box>
        ))}
      </Box>
    )

    // Translate and search: a switch, then one press picks the delegate.
    const assistPart = (kind: Assist, title: string, hint: string) => {
      const a = s[kind]
      const t = assistTarget(s, kind)
      return (
        <Box key={`a-${kind}`} flexDirection="column" gap={1} marginTop={1}>
          <Box gap={1} alignItems="center">
            {check(`${kind}.enabled`, a.enabled, title)}
          </Box>
          <Text dimColor>{a.enabled ? hint : `${hint} ${m.settings.assistOff}`}</Text>
          {a.enabled ? (
            <Box gap={1} alignItems="center" flexWrap="wrap">
              <Text>{m.settings.assistBy}</Text>
              {s.delegates.map((d, i) => (
                <Button
                  key={`${kind === 'translate' ? 'tr' : 'se'}-${i}`}
                  label={d.key}
                  variant={i === a.slot ? 'primary' : 'secondary'}
                  onPress={() => save(`${kind}.slot`, i, title)}
                />
              ))}
            </Box>
          ) : null}
          {a.enabled ? (
            <Box gap={1}>
              <Text dimColor>{`→ ${targetLabel(t, m)} · ${t.model}`}</Text>
              {found[t.tool] === null ? <Text color="yellow">{m.settings.cliMissing}</Text> : null}
            </Box>
          ) : null}
        </Box>
      )
    }
    const assist = (
      <Box key="assist" flexDirection="column" gap={1}>
        {assistPart('translate', m.settings.translate, m.settings.translateHint)}
        {assistPart('search', m.settings.search, m.settings.searchHint)}
        <Box marginTop={1}>
          <Text dimColor>{m.settings.assistNote}</Text>
        </Box>
      </Box>
    )

    const sub5 = (
      <Box key="sub5" flexDirection="column" gap={1}>
        {heading('sub5', m.settings.sub5, m.settings.sub5Hint)}
        {choice('sub5.model', m.settings.model, s.sub5.model, plain(SUB5_MODELS))}
        {choice('sub5.effort', m.settings.effort, s.sub5.effort, plain(SUB5_EFFORTS))}
        {field('sub5.max', m.settings.max, s.sub5.max, true)}
      </Box>
    )

    const advanced = (
      <Box key="advanced" flexDirection="column" gap={1}>
        {heading('paths', m.settings.paths, m.settings.pathsHint)}
        {field('paths.codexHome', m.settings.codexHome, s.paths.codexHome)}
        {field('paths.codexBin', 'codex', s.paths.codexBin)}
        {field('paths.agentBin', 'agent', s.paths.agentBin)}
        {field('paths.agyBin', 'agy', s.paths.agyBin)}
        {heading('guards', m.settings.guards)}
        <Box gap={1} flexWrap="wrap">
          {check('guards.attribution', s.guards.attribution, m.settings.attribution)}
          {check('guards.polling', s.guards.polling, m.settings.polling)}
        </Box>
        {field('guards.repeatLimit', m.settings.repeatLimit, s.guards.repeatLimit, true)}
        {heading('watch', m.settings.watch)}
        {field('watch.pollSeconds', m.settings.pollSeconds, s.watch.pollSeconds, true)}
        {field('watch.stallMinutes', m.settings.stallMinutes, s.watch.stallMinutes, true)}
        {heading('reset', m.settings.reset, m.settings.resetHint)}
        {view.isResetArmed ? (
          <Box gap={1}>
            <Button
              key="reset-confirm"
              label={m.settings.resetConfirm}
              variant="primary"
              onPress={async () => {
                const claude = asRecord(await $.settings.read().catch(() => ({})))
                await commitSettings($, defaultSettings({ attributionOff: asRecord(claude.attribution).commit === '' }))
                setView(() => ({ isResetArmed: false }))
                $.ui.toast((await msgs($)).settings.resetDone)
              }}
            />
            <Button key="reset-cancel" label={m.settings.resetCancel} variant="secondary" onPress={() => setView(() => ({ isResetArmed: false }))} />
          </Box>
        ) : (
          <Box>
            <Button key="reset" label={m.settings.reset} variant="secondary" onPress={() => setView(() => ({ isResetArmed: true }))} />
          </Box>
        )}
      </Box>
    )

    const body = { general, delegates, assist, sub5, advanced }[view.tab]
    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {body}
        <Box marginTop={1}>
          <Button key="close" label={m.settings.close} role="dismiss" onPress={() => void $.ui.close({ id: SETTINGS_PANE })} />
        </Box>
      </Box>
    )
  })

  // ── Recap pane ──────────────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: RECAP_PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const m = await msgsForDrawing($)
    const recap = await read($, recapAtom)
    return (
      <Box flexDirection="column" gap={1}>
        {recap.status === 'working' && <Text dimColor>{m.recap.working}</Text>}
        {recap.status === 'error' && <Text color="yellow">{recap.text}</Text>}
        {recap.status === 'done' && <Markdown key="recap-text" text={recap.text} />}
        <Box gap={1}>
          <Button key="again" label={m.recap.again} onPress={() => void startRecap($)} />
          {recap.status === 'done' && (
            <Button
              key="copy"
              label={m.recap.copy}
              onPress={async press => {
                const copied = await $.ui.copy({ text: recap.text, surface: press.surface }).catch(() => ({ isCopied: false }))
                if (copied.isCopied) $.ui.toast(m.recap.copied, { timeoutMs: 2_000 })
              }}
            />
          )}
          <Button key="close" label={m.recap.close} role="dismiss" onPress={() => void $.ui.close({ id: RECAP_PANE })} />
        </Box>
      </Box>
    )
  })

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
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 30) - 4) / 5))

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1}>
          <Text bold>
            {isAll ? m.codex.allProjects : m.codex.thisProject} · {m.codex.last7}
          </Text>
          <Button key="refresh" label={m.codex.refresh} onPress={() => void loadCodexThreads($)} />
          <Button
            key="scope"
            label={isAll ? m.codex.onlyThis : m.codex.showAll}
            onPress={async () => {
              await update($, codexAllAtom, all => !all)
              await loadCodexThreads($)
            }}
          />
        </Box>
        {isLoading && <Text dimColor>{m.codex.loading}</Text>}
        {error !== null && <Text color="red">{m.codex.loadFailed(error)}</Text>}
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
            <Box gap={1}>
              <Button key={`fill-${i}`} label={m.codex.fill} onPress={() => void $.prompt.fill({ text: pastePrompt(t, m) })} />
              <Button
                key={`copy-${i}`}
                label={m.codex.copyReply}
                onPress={press => void $.ui.copy({ text: t.lastAssistant, surface: press.surface })}
              />
            </Box>
          </Box>
        ))}
      </Box>
    )
  })

  // ── Guards, translation, usage, routing ─────────────────────────────────

  on('prompt.submit', async ($, e, next) => {
    // A stopped check resumes only after the user speaks again.
    strikes.clear()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const s = await cfg($)
    const m = await msgs($)
    const notes: string[] = []
    const stripped = s.guards.attribution ? stripAttribution(e.command) : null
    const command = stripped ?? e.command
    if (stripped !== null) notes.push(m.guard.stripped)
    const limit = watchSettingsOf(s).limit
    const key = s.guards.polling ? statusKey(command) : null
    if (s.guards.polling) {
      const wait = blockingWait(command, m)
      if (wait) return { deny: m.guard.blocking(wait, WATCH_TOOL) }
      if (key && (strikes.get(key)?.count ?? 0) >= limit) return { deny: m.guard.repeated(limit, WATCH_TOOL) }
    }
    const ran = await next(stripped === null ? e : { ...e, command })
    if (ran.deny !== undefined) return ran
    if (key) {
      const count = recordStrike(strikes, key, normalizeOutput(ran.text ?? ''))
      if (count >= limit) notes.push(m.guard.repeatNote(count))
    }
    return notes.length ? { ...ran, context: [...(ran.context ?? []), ...notes] } : ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TRANSLATE_TOOL }, async ($, e) => {
    const m = await msgs($)
    const s = await cfg($)
    const raw = e as unknown as Record<string, unknown>
    const input: TranslateInput = {
      text: text(raw.text),
      target: text(raw.target).trim(),
      source: text(raw.source).trim() || undefined,
      context: text(raw.context).trim() || undefined,
      glossary: Array.isArray(raw.glossary) ? raw.glossary.filter((g): g is string => typeof g === 'string') : undefined,
    }
    if (!s.translate.enabled) return { deny: m.translate.off }
    if (!input.text.trim() || !input.target) return { deny: m.translate.needs }
    if (findSecret(input.text) || findSecret(input.context ?? '')) return { deny: m.translate.sensitiveRefused }
    return runAssist($, 'translate', buildPrompt(input), out => cleanOutput(out, input.text))
  }).catch(async ($, _e, next) => ({ deny: (await msgs($)).translate.internal(errorText(next.error)) }))

  on('tool.call', { tool: SEARCH_TOOL }, async ($, e) => {
    const m = await msgs($)
    const s = await cfg($)
    const raw = e as unknown as Record<string, unknown>
    const input: SearchInput = {
      question: text(raw.question).trim(),
      context: text(raw.context).trim() || undefined,
      freshness: text(raw.freshness).trim() || undefined,
    }
    if (!s.search.enabled) return { deny: m.search.off }
    if (!input.question) return { deny: m.search.needs }
    if (findSecret(input.question) || findSecret(input.context ?? '')) return { deny: m.search.sensitiveRefused }
    return runAssist($, 'search', buildSearchPrompt(input, m.languageName), out => out.trim())
  }).catch(async ($, _e, next) => ({ deny: (await msgs($)).search.internal(errorText(next.error)) }))

  // The engine measures the session after each main-thread turn and when a limit moves a whole point:
  // the readout is pushed to, not polled.
  on('session.measure', async ($, e, next) => {
    await storeUsage($, e)
    await refreshModel($)
    if (e.changed.includes('rateLimits')) void refreshAccountUsage($).catch(() => undefined)
    await warnWhenHigh($, warned)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The effort the last turn really ran at (after any downgrade the model needed): what a switch keeps.
  on('classic.Stop', async ($, e, next) => {
    const level = effortLevel(e.effort?.level)
    if (!e.agent_id && level) await update($, effortAtom, () => level)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A /model the person sent moves the lit button; one the model button wrote (desktop) also puts the
  // effort back, from a timer since a command hook may not run another command.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e)
    await refreshModel($)
    const pending = pendingSwitch
    pendingSwitch = null
    const now = await $.clock.now()
    if (pending && pending.level && now - pending.at < 10 * 60_000 && e.args.trim().toLowerCase() === pending.alias.toLowerCase()) {
      const level = pending.level
      $.clock.after(10, () => void (async () => {
        await restoreEffort($, level, await msgs($))
      })().catch(() => undefined))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'usage-raw' }, async $ => {
    const m = await msgs($)
    const s = await cfg($)
    await loadUsage($).catch(() => undefined)
    await refreshAccountUsage($, true)
    const lines = describeSources(await read($, engineLimitsAtom), await read($, accountLimitsAtom), await $.clock.now(), m)
    const shown = (await currentSegments($, s.usage.warnPercent, true)).map(seg => seg.text).join(' · ')
    return { text: [...lines, '', m.usage.barShows(shown)].join('\n') }
  })

  on('command.run', { command: 'sub5' }, async ($, e) => {
    const note = e.args.trim()
    // The engine refuses prompt.submit from inside a command hook (it would wait on the turn this hook
    // holds): a timer's callback is a later event, and submits from there.
    $.clock.after(10, () => void startSub5($, note, false).catch(() => undefined))
    return { text: (await msgs($)).sub5.scheduled }
  })

  on('command.run', { command: 'delegate' }, async ($, e) => {
    const m = await msgs($)
    const s = await cfg($)
    const args = e.args.trim()
    const first = args.split(/\s+/)[0] ?? ''
    const target = first ? findTarget(s.delegates, first) : undefined
    if (!target) {
      return { text: m.delegate.usage(s.delegates.filter(t => t.enabled).map(t => `  ${t.key}  ${targetLabel(t, m)}`)) }
    }
    const task = args.slice(first.length).trim()
    // Same as /sub5: the engine refuses prompt.submit from inside a command hook, a timer submits later.
    $.clock.after(10, () => void startDelegate($, target, task, false, false).catch(() => undefined))
    return { text: m.delegate.scheduled(target.key) }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const s = await cfg($)
    return { sections: [...composed.sections, { id: 'deckhand:routing', text: routing(s), scope: 'session' as const }] }
  })
}

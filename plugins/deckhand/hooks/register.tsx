import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderSurface, Timer } from 'claude-code'

import type {
  AccountLimits,
  CodexThread,
  DelegateAnswer,
  DelegateRecord,
  DelegateRun,
  DelegateTool,
  EngineLimit,
  Locale,
  RecapState,
  SettingsFileView,
  SettingsView,
  Sub5Leftover,
  Sub5Leftovers,
  Watch,
} from '../types'
import { ago, parseChecked, parseWritten, pastePrompt, stateLine, threadsArgv, unfence } from './codex'
import { assistArgv, delegatePrompt, findTarget, SEARCH_MINUTES, targetLabel, TOOL_NAME, TRANSLATE_MINUTES } from './delegate'
import { fingerprintBody, headerOf } from './fingerprint'
import { blockingWait, executable, normalizeOutput, recordStrike, statusKey, stripAttribution } from './guard'
import type { Strike } from './guard'
import { LANGUAGE_NAME, LOCALES, messages, resolveLocale } from './i18n'
import type { Messages } from './i18n'
import {
  changedFields,
  DEFAULT_SEARCH_SLOT,
  DEFAULT_TRANSLATE_SLOT,
  defaultSettings,
  DELEGATE_EFFORTS,
  DELEGATE_TOOLS,
  expandHome,
  fieldOf,
  normalizeSettings,
  SETTINGS_FILE,
  settingsFileText,
  SUB5_EFFORTS,
  SUB5_MODELS,
  withField,
} from './settings'
import type { DelegateTarget, Settings } from './settings'
import { errorText, lastLine, noteForModel, text } from './state'
import {
  exitCodeOf,
  matchRecord,
  parseDelegateCall,
  parseDelegateOutput,
  parseMetaUsage,
  parseRecords,
  parseTaskNotification,
  pasteAnswer,
  recordResult,
  recordsTotal,
  runLine,
  whoOf,
} from './runs'
import type { DelegateCall } from './runs'
import { isActionable, leftoverLine, leftoversArgv, parseCleaned, parseLeftovers, SUB5_AGENT, sub5Prompt, workerSpec } from './sub5'
import { buildSearchPrompt, SEARCH_SCHEMA } from './search'
import type { SearchInput } from './search'
import { buildPrompt, cleanOutput, findSecret, TRANSLATE_SCHEMA } from './translate'
import type { TranslateInput } from './translate'
import {
  describeSources,
  effortLevel,
  desktopModelArg,
  learnModelId,
  MODEL_BUTTONS,
  modelFamily,
  parseAccountUsage,
  planSwitch,
  scopedFamily,
  shownPercent,
  usageSegments,
} from './usage'
import type { Family, Segment } from './usage'
import {
  asRecord,
  cfg,
  cfgForDrawing,
  isDesktopApp,
  currentLocale,
  knownScoped,
  loadSettings,
  msgs,
  msgsForDrawing,
  rememberScoped,
  resolveBin,
  storeSettings,
} from './core'
import type { Engine } from './core'
import { RECAP_PANE, registerRecap, startRecap } from './recap'
import { cellWidth, EMPTY, listRoom, NARROW_COLUMNS, runState, TONE, TOAST, usageTone, watchState } from './ui'
import { RELEASES_URL, isCheckDue, isNewer, latestVersion, readUpdateState } from './updates'
import { advance, describeWatch, errorResult, failedJobs, ghArgs, isNoRepo, newWatch, notice, parseTarget, prResult, runResult, urlResult, withAllowedFailures } from './watch'
import type { CheckResult, PrView, RunItem, WatchSettings } from './watch'
import { CODEX_PANE, registerHandoff, syncSharedTool } from './handoff'
import { leftoversState, loadLeftovers, openLeftovers, registerLeftovers, SUB5_CLEAN_PANE } from './leftovers'
import { bandWatches, clearFinished, hideWatches, isBandHidden, registerWatches, resumeWatches, stopWatches, WATCH_TOOL, watchSettingsOf } from './watches'
import { awaitedRuns, bandRuns, clearFinishedRows, DELEGATES_PANE, isFinished, noteTaskEnded, openRecords, registerDelegates, settleRun, startRun, syncRunTimers } from './delegates'
import { currentModel, currentSegments, loadUsage, pressModel, refreshAccountUsage, refreshModel, registerModels, rememberEffort } from './models'


const TRANSLATE_TOOL = 'mcp__deckhand__translate'
const SEARCH_TOOL = 'mcp__deckhand__search'
const SETTINGS_PANE = 'deckhand-settings'


/** Whether the settings pane is open: ⚙ is a toggle, drawn pressed while it is. */
const settingsOpenAtom = atom({ plugin: 'deckhand', key: 'isSettingsOpen' } as const, false)
const settingsViewAtom = atom({ plugin: 'deckhand', key: 'settingsView' } as const, { tab: 'general', editing: -1, isResetArmed: false } as SettingsView)
const settingsFileAtom = atom({ plugin: 'deckhand', key: 'settingsFile' } as const, {
  path: SETTINGS_FILE,
  armed: null,
  pending: null,
  changes: 0,
} as SettingsFileView)
const binsAtom = atom({ plugin: 'deckhand', key: 'bins' } as const, {} as Partial<Record<DelegateTool, string | null>>)


// ── Settings and language ───────────────────────────────────────────────────


/**
 * Each open pane of the plugin in the current language. A pane keeps the title it was opened with, and the
 * app does not always draw an open pane again when the language changes: the settings pane, where the
 * language is picked, is closed and opened again (its tab is kept); the others are retitled in place.
 */
async function retitlePanes($: Engine, m: Messages) {
  const titles: Record<string, string> = {
    [SETTINGS_PANE]: m.settings.title,
    [DELEGATES_PANE]: m.delegate.recordsTitle,
    [RECAP_PANE]: m.recap.paneTitle,
    [SUB5_CLEAN_PANE]: m.sub5.cleanTitle,
    [CODEX_PANE]: m.codex.paneTitle,
  }
  for (const pane of await $.ui.panes().catch(() => [])) {
    const title = titles[pane.id]
    if (!title) continue
    if (pane.id === SETTINGS_PANE) await $.ui.close({ id: SETTINGS_PANE }).catch(() => undefined)
    await $.ui.open({ id: pane.id, title, ...(pane.id === SETTINGS_PANE ? { focus: true } : {}) }).catch(() => undefined)
  }
}

/** Saves settings, then redoes what depends on them: the language, the commands, the worker, the CLIs. */
async function commitSettings($: Engine, next: Settings) {
  const before = await cfg($)
  const localeBefore = await currentLocale($)
  const claude = asRecord(await $.settings.read().catch(() => ({})))
  await storeSettings($, next, claude.language)
  const m = await msgs($)
  if ((await currentLocale($)) !== localeBefore) await retitlePanes($, m)
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
        locale: await currentLocale($),
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
    $.ui.toast(m.settings.invalid(label), { timeoutMs: TOAST.problem })
    return
  }
  await commitSettings($, next)
  // Read the catalog again: the edit may have been the language itself.
  $.ui.toast((await msgs($)).settings.saved, { timeoutMs: TOAST.done })
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
  await $.command.register({ name: 'sub5-clean', description: m.sub5.cleanDescription })
  await $.command.register({ name: 'delegate', description: m.delegate.commandDescription(keys.replace(/\|/g, '/')), argumentHint: m.delegate.commandHint(keys) })
  await $.command.register({ name: 'delegates', description: m.delegate.recordsDescription })
  await $.command.register({ name: 'usage-raw', description: m.usage.rawCommand })
  await $.command.register({ name: 'deckhand', description: m.settings.commandDescription })
}

async function registerWorker($: Engine, m: Messages, s: Settings) {
  await $.agent
    .register(workerSpec({ model: s.sub5.model, effort: s.sub5.effort, languageName: m.languageName, attribution: s.guards.attribution }))
    .catch(error => $.ui.log(`deckhand: ${SUB5_AGENT} not registered (${errorText(error)})`))
}

/** Which delegate CLIs are installed, as bin/delegate.py finds them: a button whose CLI is missing is hidden. */
/**
 * Once a day at most: the newest GitHub Release against the installed version. A newer one gets one toast,
 * once per version; the setting `updates.check` turns this off. Failures stay quiet: the next session asks again.
 */
async function checkForUpdate($: Engine) {
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











// ── Codex inbox and handoff ─────────────────────────────────────────────────





// ── Usage readout ───────────────────────────────────────────────────────────











/** One toast per limit and level, for the highest level crossed; it speaks again after the window resets. */


// ── Model buttons ───────────────────────────────────────────────────────────



/**
 * A click on O / F / S / H.
 *
 * The desktop app owns the session's model: it applies its own menu's pick to every turn, and its menu
 * follows only a /model the person sends. A switch made behind its back is undone on the next turn,
 * and no plugin call reaches its menu: `$.prompt.submit` refuses a text starting with `/`, the app
 * refuses a session setting its own model, and no call moves the focus into the composer. So there
 * the button writes `/model <family>` into the prompt box and the person presses Enter: the app's own
 * path, menu included. Where the box cannot take it, the command goes to the clipboard instead.
 *
 * Elsewhere (the terminal) the engine owns the model: `/model <family>` runs at once, then the effort
 * the last turn ran at is put back, because switching models otherwise loads the new model's own level.
 */




// ── Handing work to the main agent ──────────────────────────────────────────

/** A hand-over pressed while a turn ran: sent when that turn ends, so the running turn never reads it. */
let heldHandOver: { visible: string; brief: string } | null = null

/**
 * What the Sub5 and delegate buttons hand the main agent: the full brief as a row only the model reads,
 * then one short line in the person's name, so the transcript shows the request and not the procedure.
 * If the engine will not take the row, the brief goes as the prompt itself, as before.
 */
async function handOver($: Engine, visible: string, brief: string) {
  const row = await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text: brief }] } })
    .catch(() => ({ deny: 'failed' }) as const)
  await $.prompt.submit({ text: row.deny ? brief : visible, asUser: true })
}

/** Now when idle; when a turn runs, held for its end (the brief row would otherwise reach that turn). */
async function handOverWhenIdle($: Engine, visible: string, brief: string, isWorking: boolean) {
  if (isWorking) {
    heldHandOver = { visible, brief }
    return
  }
  await handOver($, visible, brief)
}

// ── Sub5 ────────────────────────────────────────────────────────────────────

let lastSub5At = 0

/** The Sub5 button and `/sub5`: hands the main agent the flow as the user's own instruction. */
async function startSub5($: Engine, note: string, isWorking: boolean) {
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

// ── Delegate runs: the band's progress rows ─────────────────────────────────

















// ── Delegate records: the pane ──────────────────────────────────────────────







async function openSettings($: Engine) {
  const m = await msgs($)
  await $.ui.open({ id: SETTINGS_PANE, title: m.settings.title, focus: true })
  await update($, settingsOpenAtom, () => true)
  if ((await read($, settingsViewAtom)).tab === 'sub5') void loadLeftovers($).catch(() => undefined)
}

/** ⚙: closes the settings pane when it is the one shown, opens (or brings it forward) otherwise. */
async function toggleSettings($: Engine) {
  const pane = (await $.ui.panes().catch(() => [])).find(p => p.id === SETTINGS_PANE)
  if (pane?.isShown) {
    await closeSettings($)
    return
  }
  await openSettings($)
}

/** The plugin's own close does not pass through its own ui.close hook: the state is cleared here. */
async function closeSettings($: Engine) {
  await $.ui.close({ id: SETTINGS_PANE })
  await update($, settingsOpenAtom, () => false)
}

// ── Settings file: export, import, copy ─────────────────────────────────────

async function setFile($: Engine, patch: Partial<SettingsFileView>) {
  await update($, settingsFileAtom, v => ({ ...v, ...patch }))
}

const DISARMED: Partial<SettingsFileView> = { armed: null, pending: null, changes: 0 }

/** The typed path as shown and with `~` expanded; null (and a toast) when there is none to use. */
async function settingsFilePath($: Engine, m: Messages): Promise<{ shown: string; full: string } | null> {
  const shown = (await read($, settingsFileAtom)).path.trim()
  const home = shown.startsWith('~') ? ((await $.env.get('HOME').catch(() => undefined)) ?? '') : ''
  if (!shown || /[\n\r\0]/.test(shown) || (shown.startsWith('~') && !home)) {
    $.ui.toast(m.settings.fileNoPath, { timeoutMs: TOAST.problem })
    return null
  }
  return { shown, full: expandHome(shown, home) }
}

/** Writes the settings to the typed path; a file already there is replaced only on the second press. */
async function exportSettings($: Engine, isConfirmed: boolean) {
  const m = await msgs($)
  const where = await settingsFilePath($, m)
  if (!where) return
  try {
    if (!isConfirmed && (await $.fs.exists(where.full))) {
      await setFile($, { ...DISARMED, armed: 'export' })
      return
    }
    await $.fs.write(where.full, settingsFileText(await cfg($)))
    await setFile($, DISARMED)
    $.ui.toast(m.settings.exported(where.shown), { timeoutMs: TOAST.done })
  } catch (error) {
    $.ui.toast(m.settings.exportFailed(errorText(error)), { timeoutMs: TOAST.problem })
  }
}

/**
 * Reads a settings file and checks it against the current settings, field by field, as the store is
 * read; what would change waits for the Apply press. A missing or unreadable file changes nothing.
 */
async function readImport($: Engine) {
  const m = await msgs($)
  const where = await settingsFilePath($, m)
  if (!where) return
  await setFile($, DISARMED)
  let text: string
  try {
    if (!(await $.fs.exists(where.full))) {
      $.ui.toast(m.settings.importMissing(where.shown), { timeoutMs: TOAST.problem })
      return
    }
    text = await $.fs.read(where.full)
  } catch (error) {
    $.ui.toast(m.settings.importFailed(errorText(error)), { timeoutMs: TOAST.problem })
    return
  }
  const raw = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return null
    }
  })()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    $.ui.toast(m.settings.importInvalid(where.shown), { timeoutMs: TOAST.problem })
    return
  }
  const s = await cfg($)
  const next = normalizeSettings(raw, s, LOCALES)
  const changes = changedFields(s, next).length
  if (!changes) {
    $.ui.toast(m.settings.importSame, { timeoutMs: TOAST.info })
    return
  }
  await setFile($, { armed: 'import', pending: next, changes })
}

async function applyImport($: Engine) {
  const file = await read($, settingsFileAtom)
  if (!file.pending) return
  await commitSettings($, file.pending)
  await setFile($, DISARMED)
  // Read the catalog again: the import may have changed the language.
  $.ui.toast((await msgs($)).settings.imported(file.changes), { timeoutMs: TOAST.done })
}

async function copySettings($: Engine, surface: Parameters<Engine['ui']['copy']>[0]['surface']) {
  const m = await msgs($)
  const copied = await $.ui.copy({ text: settingsFileText(await cfg($)), surface }).catch(() => ({ isCopied: false }))
  $.ui.toast(copied.isCopied ? m.settings.copied : m.settings.copyFailed, { timeoutMs: TOAST.done })
}

// ── Sub5 leftovers: what interrupted runs left behind ───────────────────────







// ── Routing: what the model is told about the plugin ────────────────────────

const who = (t: DelegateTarget) => `${t.key}: ${TOOL_NAME[t.tool]} · ${t.name}`


/** A command about a pull request: in the desktop app its CI is the app PR bar's to watch. */
const PR_COMMAND = /\bgh\s+pr\b|\/pulls\/\d+/

const NO_POLLING =
  'Never poll with sleep loops, `gh run watch`, `gh pr checks --watch` or repeated gh/curl status checks; the plugin polls locally, stops itself after repeated identical results and notifies the user.'

const routing = (s: Settings, isDesktop: boolean) =>
  [
    "Deckhand (the user's Claude Code plugin):",
    isDesktop
      ? `- In the desktop app a PR's CI is watched by the app: bind the PR with the ccd_pr tools and let its CI monitor notify you. To wait for an Actions run, a commit's CI (sha:), a merge's CI or a deploy, call ${WATCH_TOOL} once and end your turn. ${NO_POLLING}`
      : `- To wait for a PR, CI run, merge or deploy, call ${WATCH_TOOL} once and end your turn. ${NO_POLLING}`,
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
    // The desktop app already tells the model this in every session; the guard still strips what slips through.
    ...(s.guards.attribution && !isDesktop ? ['- Commit messages and PR descriptions carry no Co-Authored-By trailer and no "Generated with Claude Code" footer.'] : []),
  ].join('\n')

// ── Hooks ───────────────────────────────────────────────────────────────────

export const register: Register = on => {
  registerModels(on)
  registerDelegates(on)
  registerWatches(on)
  registerLeftovers(on)
  registerHandoff(on)
  registerRecap(on)
  const strikes = new Map<string, Strike>()

  on('session.start', async ($, e, next) => {
    const s = await loadSettings($)
    // After a reload the engine still knows which panes are up; ⚙ reads its state from that.
    const isUp = (await $.ui.panes().catch(() => [])).some(p => p.id === SETTINGS_PANE)
    await update($, settingsOpenAtom, () => isUp)
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
    await syncRunTimers($)
    await loadUsage($).catch(() => undefined)
    await refreshModel($)
    void refreshAccountUsage($, true).catch(() => undefined)
    void checkBins($).catch(() => undefined)
    void checkForUpdate($).catch(() => undefined)
    return next(e)
  })

  // The band above the prompt: the running watches, then the control row: the usage readout, the model
  // buttons, Sub5, the delegates, the recap, a tip slot that takes the free width, and ⚙ at the right end.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await msgsForDrawing($)
    const s = await cfgForDrawing($)
    const watches = await bandWatches($)
    const hasWatches = watches.length > 0 && !(await isBandHidden($))
    const hasFinished = watches.some(w => w.status !== 'watching')
    // Delegate runs: read the tick so the elapsed time is drawn again every second.
    const runs = s.show.delegates ? await bandRuns($) : []
    const now = runs.length ? await $.clock.now() : 0
    const segments = s.show.usage ? await currentSegments($, s.usage.warnPercent, true) : []
    const family = modelFamily(await currentModel($))
    const found = await read($, binsAtom)
    const isWorking = e.props.isWorking
    const isSettingsOpen = await read($, settingsOpenAtom)
    const isDesktop = e.surface === 'desktop'
    // In the desktop app its own model menu switches in a click; the buttons only fill `/model <id>` there.
    const showModels = s.show.models && (!isDesktop || s.show.modelsOnDesktop)
    // A target whose CLI is known to be missing has no button; an unchecked one keeps it.
    const targets = s.show.delegates ? s.delegates.filter(t => t.enabled && found[t.tool] !== null) : []
    const scope = (id: string) => `deckhand-tip-${id}`
    const tips = [
      ...(segments.length ? [{ id: 'usage', text: m.tips.usage }] : []),
      ...(showModels ? MODEL_BUTTONS.map(b => ({ id: `m-${b.key}`, text: isDesktop ? m.tips.modelDesktop(b.name) : m.tips.model(b.name) })) : []),
      ...(s.show.sub5 ? [{ id: 'sub5', text: m.tips.sub5(s.sub5.max) }] : []),
      ...targets.map(t => ({ id: `d-${t.key}`, text: m.tips.delegate(targetLabel(t, m)) })),
      ...(s.show.recap ? [{ id: 'recap', text: m.tips.recap }] : []),
      { id: 'gear', text: m.tips.settings },
      ...runs.filter(isFinished).map(r => ({ id: `dr-${r.id}`, text: m.delegate.recordsTip })),
    ]
    // Clear and Hide end the last watch or delegate row instead of taking a line of their own.
    const shownWatches = hasWatches ? watches.slice(-4) : []
    const lastRow = runs.length ? `r-${runs[runs.length - 1]!.id}` : shownWatches.length ? `w-${shownWatches[shownWatches.length - 1]!.id}` : ''
    const rowActions = [
      ...((hasWatches && hasFinished) || runs.some(isFinished)
        ? [<Button key="clear" label={m.watch.clearDone} variant="secondary" onPress={() => void clearFinishedRows($)} />]
        : []),
      ...(hasWatches ? [<Button key="hide" label={m.watch.hide} variant="secondary" onPress={() => void hideWatches($)} />] : []),
    ]
    return (
      <Box flexDirection="column">
        {shownWatches.map(w => {
          const state = watchState(w.status)
          return (
          <Box key={`w-${w.id}`} gap={1}>
            <Text color={state.tone && TONE[state.tone]}>
              {state.mark} {w.label}
            </Text>
            <Text dimColor wrap="truncate">
              {w.reason ?? w.summary}
              {w.status === 'watching' ? m.watch.checkCount(w.checks) : ''}
            </Text>
            {w.status === 'watching' && <Button key={`stop-${w.id}`} label={m.watch.stop} variant="secondary" onPress={() => void stopWatches($, w.id)} />}
            {lastRow === `w-${w.id}` && rowActions}
          </Box>
          )
        })}
        {runs.map(r => {
          const line = runLine(r, now, m)
          const state = runState(r.status)
          return (
            <Box key={`r-${r.id}`} gap={1}>
              <Text color={state.tone && TONE[state.tone]}>
                {line.mark} {r.label}
              </Text>
              <Text dimColor wrap="truncate">
                {line.text}
              </Text>
              {isFinished(r) && (
                <Button
                  key={`dr-${r.id}`}
                  label={m.delegate.records}
                  variant="secondary"
                  hover={{ scope: scope(`dr-${r.id}`) }}
                  onPress={() =>
                    void openRecords($, r.answerPath && r.status === 'answered' ? { path: r.answerPath, label: r.label, who: whoOf(r.tool, r.name, m) } : undefined)
                  }
                />
              )}
              {lastRow === `r-${r.id}` && rowActions}
            </Box>
          )
        })}
        <Box gap={1} flexWrap="wrap">
          {/* The gauges, a quiet dot between them; only a gauge near its limit takes a colour. */}
          {segments.flatMap((seg, i) => [
            ...(i > 0 ? [<Text key={`u-sep-${seg.id}`} dimColor hover={{ scope: scope('usage') }}>·</Text>] : []),
            <Text
              key={`u-${seg.id}`}
              color={seg.level === 'high' || seg.level === 'warn' ? TONE[usageTone(seg.level)] : undefined}
              dimColor={seg.level === 'ok' || seg.level === 'unknown'}
              hover={{ scope: scope('usage') }}
            >
              {seg.text}
            </Text>,
          ])}
          {showModels &&
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
          <Button key="gear" label="⚙" variant={isSettingsOpen ? 'primary' : 'secondary'} hover={{ scope: scope('gear') }} onPress={() => void toggleSettings($)} />
        </Box>
      </Box>
    )
  })

  // ── Settings pane ───────────────────────────────────────────────────────

  // Closed by its ✕ or by the engine: ⚙ stops being drawn pressed.
  on('ui.close', { id: SETTINGS_PANE }, async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      await update($, settingsOpenAtom, () => false)
    }
  })

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
    const file = await read($, settingsFileAtom)
    const leftovers = await leftoversState($)
    // A label beside its field reads fastest; a narrow pane stacks them.
    const isNarrow = e.props.bodyColumns < NARROW_COLUMNS
    const setView = (patch: (v: SettingsView) => Partial<SettingsView>) =>
      void update($, settingsViewAtom, v => ({ ...v, ...patch(v) })).catch(() => undefined)
    const save = (field: string, value: unknown, label: string) => void saveField($, field, value, label).catch(() => undefined)

    const check = (field: string, value: boolean, label: string) => (
      <Button key={`t-${field}`} label={`${value ? '☑' : '☐'} ${label}`} variant="secondary" onPress={() => save(field, !value, label)} />
    )
    // The labels of the shown tab: the label column is as wide as its longest one (a CJK character takes two cells).
    const tabLabels: Record<SettingsView['tab'], string[]> = {
      general: [m.settings.language, m.settings.warnPercent],
      delegates: [m.settings.label, m.settings.tool, m.settings.modelId, m.settings.effort, m.settings.name],
      assist: [],
      sub5: [m.settings.model, m.settings.effort, m.settings.max],
      advanced: [m.settings.codexHome, TOOL_NAME.codex, TOOL_NAME.agent, TOOL_NAME.agy, m.settings.repeatLimit, m.settings.pollSeconds, m.settings.stallMinutes, m.settings.filePath],
    }
    const labelWidth = Math.min(30, Math.max(8, ...tabLabels[view.tab].map(cellWidth)))
    const row = (key: string, label: string, control: RenderElement) => (
      <Box key={`r-${key}`} flexDirection={isNarrow ? 'column' : 'row'} columnGap={2} alignItems={isNarrow ? 'flex-start' : 'center'}>
        <Box width={isNarrow ? undefined : labelWidth} flexShrink={0}>
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
          <Text key={`i-${key}`}>{String(value) || EMPTY}</Text>
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
    const heading = (key: string, title: string, hint?: string, isFirst = false) => (
      <Box key={`h-${key}`} flexDirection="column" marginTop={isFirst ? 0 : 1}>
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
            onPress={() => {
              setView(() => ({ tab: t, editing: -1, isResetArmed: false }))
              void setFile($, DISARMED).catch(() => undefined)
              if (t === 'sub5') void loadLeftovers($).catch(() => undefined)
            }}
          />
        ))}
      </Box>
    )

    const general = (
      <Box key="general" flexDirection="column" gap={1}>
        {heading('display', m.settings.display, undefined, true)}
        {choice('language', m.settings.language, s.language, [
          { value: 'auto', label: m.settings.auto },
          ...LOCALES.map(l => ({ value: l, label: LANGUAGE_NAME[l] })),
        ])}
        {heading('buttons', m.settings.buttons, m.settings.buttonsHint)}
        <Box gap={1} flexWrap="wrap">
          {check('show.usage', s.show.usage, m.settings.showUsage)}
          {check('show.models', s.show.models, m.settings.showModels)}
          {s.show.models && check('show.modelsOnDesktop', s.show.modelsOnDesktop, m.settings.showModelsOnDesktop)}
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
        {heading('delegates', m.settings.delegates, m.settings.delegatesHint, true)}
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
              {found[t.tool] === null ? <Text color={TONE.warn}>{m.settings.cliMissing}</Text> : null}
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
        <Box key={`a-${kind}`} flexDirection="column" gap={1}>
          <Box gap={1} alignItems="center">
            {check(`${kind}.enabled`, a.enabled, title)}
          </Box>
          <Text dimColor>{a.enabled ? hint : `${hint}${m.settings.assistOff}`}</Text>
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
              {found[t.tool] === null ? <Text color={TONE.warn}>{m.settings.cliMissing}</Text> : null}
            </Box>
          ) : null}
        </Box>
      )
    }
    const assist = (
      <Box key="assist" flexDirection="column" gap={1}>
        {heading('assist', m.settings.tabs.assist, m.settings.assistNote, true)}
        {assistPart('translate', m.settings.translate, m.settings.translateHint)}
        {assistPart('search', m.settings.search, m.settings.searchHint)}
      </Box>
    )

    const sub5 = (
      <Box key="sub5" flexDirection="column" gap={1}>
        {heading('sub5', m.settings.sub5, m.settings.sub5Hint, true)}
        {choice('sub5.model', m.settings.model, s.sub5.model, plain(SUB5_MODELS))}
        {choice('sub5.effort', m.settings.effort, s.sub5.effort, plain(SUB5_EFFORTS))}
        {field('sub5.max', m.settings.max, s.sub5.max, true)}
        <Box key="leftovers" gap={1} alignItems="center">
          <Text dimColor>{m.settings.leftovers(leftovers.status === 'done' ? leftovers.entries.length : null)}</Text>
          <Button key="sub5-leftovers" label={m.settings.leftoversOpen} variant="secondary" onPress={() => void openLeftovers($).catch(() => undefined)} />
        </Box>
      </Box>
    )

    const advanced = (
      <Box key="advanced" flexDirection="column" gap={1}>
        {heading('paths', m.settings.paths, m.settings.pathsHint, true)}
        {field('paths.codexHome', m.settings.codexHome, s.paths.codexHome)}
        {field('paths.codexBin', TOOL_NAME.codex, s.paths.codexBin)}
        {field('paths.agentBin', TOOL_NAME.agent, s.paths.agentBin)}
        {field('paths.agyBin', TOOL_NAME.agy, s.paths.agyBin)}
        {heading('guards', m.settings.guards)}
        <Box gap={1} flexWrap="wrap">
          {check('guards.attribution', s.guards.attribution, m.settings.attribution)}
          {check('guards.polling', s.guards.polling, m.settings.polling)}
        </Box>
        {field('guards.repeatLimit', m.settings.repeatLimit, s.guards.repeatLimit, true)}
        {heading('updates', m.settings.updates, m.settings.updatesHint)}
        <Box gap={1} flexWrap="wrap">
          {check('updates.check', s.updates.check, m.settings.updateCheck)}
        </Box>
        {heading('watch', m.settings.watch)}
        {field('watch.pollSeconds', m.settings.pollSeconds, s.watch.pollSeconds, true)}
        {field('watch.stallMinutes', m.settings.stallMinutes, s.watch.stallMinutes, true)}
        {heading('file', m.settings.file, m.settings.fileHint)}
        {row(
          'settingsFile',
          m.settings.filePath,
          Input ? (
            <Input
              key="i-settingsFile"
              value={file.path}
              submitLabel={m.settings.fileUse}
              onInput={(v: string) => void setFile($, { ...DISARMED, path: v }).catch(() => undefined)}
              onSubmit={(v: string) => void setFile($, { ...DISARMED, path: v }).catch(() => undefined)}
            />
          ) : (
            <Text key="i-settingsFile">{file.path}</Text>
          ),
        )}
        <Box gap={1} flexWrap="wrap">
          <Button key="file-export" label={m.settings.fileExport} variant="secondary" onPress={() => void exportSettings($, false).catch(() => undefined)} />
          <Button key="file-import" label={m.settings.fileImport} variant="secondary" onPress={() => void readImport($).catch(() => undefined)} />
          <Button key="file-copy" label={m.settings.fileCopy} variant="secondary" onPress={press => void copySettings($, press.surface).catch(() => undefined)} />
        </Box>
        {file.armed !== null ? (
          <Box gap={1} alignItems="center" flexWrap="wrap">
            <Text color={TONE.warn}>{file.armed === 'export' ? m.settings.fileExists(file.path) : m.settings.importChanges(file.changes)}</Text>
            {file.armed === 'export' ? (
              <Button key="file-overwrite" label={m.settings.fileOverwrite} variant="primary" onPress={() => void exportSettings($, true).catch(() => undefined)} />
            ) : (
              <Button key="file-apply" label={m.settings.importApply} variant="primary" onPress={() => void applyImport($).catch(() => undefined)} />
            )}
            <Button key="file-cancel" label={m.settings.fileCancel} variant="secondary" onPress={() => void setFile($, DISARMED).catch(() => undefined)} />
          </Box>
        ) : null}
        {heading('reset', m.settings.reset, m.settings.resetHint)}
        {view.isResetArmed ? (
          <Box gap={1} alignItems="center" flexWrap="wrap">
            <Text color={TONE.bad}>{m.settings.resetSure}</Text>
            <Button
              key="reset-confirm"
              label={m.settings.resetConfirm}
              variant="primary"
              onPress={async () => {
                const claude = asRecord(await $.settings.read().catch(() => ({})))
                await commitSettings($, defaultSettings({ attributionOff: asRecord(claude.attribution).commit === '' }))
                setView(() => ({ isResetArmed: false }))
                $.ui.toast((await msgs($)).settings.resetDone, { timeoutMs: TOAST.done })
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
        {e.surface !== 'desktop' && (
          <Box>
            <Button key="close" label={m.settings.close} role="dismiss" onPress={() => void closeSettings($)} />
          </Box>
        )}
      </Box>
    )
  })

  // ── Guards, translation, usage, routing ─────────────────────────────────

  on('prompt.submit', async ($, e, next) => {
    // A stopped check resumes only after the user speaks again.
    strikes.clear()
    // A background delegate run ends with its task's notification.
    if (e.text.includes('<task-notification>')) void noteTaskEnded($, e.text).catch(() => undefined)
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
      const isStuck = key !== null && (strikes.get(key)?.count ?? 0) >= limit
      const isAppPr = (wait !== null || isStuck) && PR_COMMAND.test(executable(command)) && (await isDesktopApp($))
      if (wait) return { deny: isAppPr ? m.guard.blockingPr(wait) : m.guard.blocking(wait, WATCH_TOOL) }
      if (isStuck) return { deny: isAppPr ? m.guard.repeatedPr(limit) : m.guard.repeated(limit, WATCH_TOOL) }
    }
    // A delegate.py run gets a row in the band while it runs; its brief is never read.
    const call = s.show.delegates ? parseDelegateCall(command) : null
    const runId = call ? await startRun($, call, e.tool_use_id || `run-${(await $.clock.now()).toString(36)}`).catch(() => null) : null
    let ran
    try {
      ran = await next(stripped === null ? e : { ...e, command })
    } finally {
      if (runId) awaitedRuns.delete(runId)
    }
    if (runId) await settleRun($, runId, ran).catch(() => undefined)
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
  // The effort the last turn really ran at (after any downgrade the model needed): what a switch keeps.
  on('classic.Stop', async ($, e, next) => {
    const level = effortLevel(e.effort?.level)
    if (!e.agent_id && level) await rememberEffort($, level)
    const held = e.agent_id ? null : heldHandOver
    if (held) {
      heldHandOver = null
      // After the turn has ended: a hook may not start the next turn itself.
      $.clock.after(10, () => void handOver($, held.visible, held.brief).catch(error => $.ui.log(`deckhand: hand-over not sent (${errorText(error)})`)))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

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
    return { sections: [...composed.sections, { id: 'deckhand:routing', text: routing(s, await isDesktopApp($)), scope: 'session' as const }] }
  })
}

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
import { ASSISTS, assistTarget, checkBins, checkForUpdate, foundBins, registerAssist, registerCommands, registerWorker } from './session'
import type { Assist } from './session'
import { isSettingsShown, markSettingsOpen, registerSettingsPane, SETTINGS_PANE, toggleSettings } from './settings-pane'
import { sendHeldHandOver, startDelegate, startSub5 } from './actions'
import { registerBand } from './band'


const TRANSLATE_TOOL = 'mcp__deckhand__translate'
const SEARCH_TOOL = 'mcp__deckhand__search'




// ── Settings and language ───────────────────────────────────────────────────




// ── Translate and search: work handed to a delegate, off until the person turns it on ──





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




/** Which delegate CLIs are installed, as bin/delegate.py finds them: a button whose CLI is missing is hidden. */



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



/** Now when idle; when a turn runs, held for its end (the brief row would otherwise reach that turn). */


// ── Sub5 ────────────────────────────────────────────────────────────────────



// ── Delegate ────────────────────────────────────────────────────────────────



// ── Delegate runs: the band's progress rows ─────────────────────────────────

















// ── Delegate records: the pane ──────────────────────────────────────────────












// ── Settings file: export, import, copy ─────────────────────────────────────








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
  registerBand(on)
  registerSettingsPane(on)
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
    await markSettingsOpen($, isUp)
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
    if (!e.agent_id) sendHeldHandOver($)
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

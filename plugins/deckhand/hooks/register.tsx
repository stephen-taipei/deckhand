import { read } from 'claude-code'
import type { Register } from 'claude-code'

import type { DelegateTool, Watch } from '../types'
import { sendHeldHandOver, startDelegate, startSub5 } from './actions'
import { registerBand } from './band'
import { cfg, currentLocale, isDesktopApp, loadSettings, msgs, resolveBin } from './core'
import type { Engine } from './core'
import { assistArgv, findTarget, SEARCH_MINUTES, targetLabel, TOOL_NAME, TRANSLATE_MINUTES } from './delegate'
import { awaitedRuns, noteTaskEnded, registerDelegates, settleRun, startRun, syncRunTimers } from './delegates'
import { blockingWait, executable, normalizeOutput, recordStrike, statusKey, stripAttribution } from './guard'
import type { Strike } from './guard'
import { registerHandoff, syncSharedTool } from './handoff'
import { messages } from './i18n'
import { registerLeftovers } from './leftovers'
import { loadUsage, refreshAccountUsage, refreshModel, registerModels, rememberEffort } from './models'
import { registerRecap } from './recap'
import { parseDelegateCall } from './runs'
import { buildSearchPrompt } from './search'
import type { SearchInput } from './search'
import { ASSISTS, assistTarget, checkBins, checkForUpdate, registerAssist, registerCommands, registerWorker } from './session'
import type { Assist } from './session'
import type { DelegateTarget, Settings } from './settings'
import { markSettingsOpen, registerSettingsPane, SETTINGS_PANE } from './settings-pane'
import { errorText, text } from './state'
import { buildPrompt, cleanOutput, findSecret } from './translate'
import type { TranslateInput } from './translate'
import { effortLevel } from './usage'
import { registerWatches, resumeWatches, WATCH_TOOL, watchSettingsOf } from './watches'

const TRANSLATE_TOOL = 'mcp__deckhand__translate'
const SEARCH_TOOL = 'mcp__deckhand__search'

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

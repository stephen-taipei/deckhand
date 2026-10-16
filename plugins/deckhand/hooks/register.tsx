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
    const found = await foundBins($)
    const isWorking = e.props.isWorking
    const isSettingsOpen = await isSettingsShown($)
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

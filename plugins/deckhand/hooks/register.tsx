import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AccountLimits, CodexThread, EngineLimit, Watch } from '../types'
import {
  ago,
  HANDOFF_PROMPT,
  parseChecked,
  parseWritten,
  pastePrompt,
  stateLine,
  threadsArgv,
  unfence,
} from './codex'
import { DELEGATES, delegateLabel, delegatePrompt, delegateTarget } from './delegate'
import { fingerprintBody, headerOf } from './fingerprint'
import { blockingWait, normalizeOutput, recordStrike, statusKey, stripAttribution } from './guard'
import type { Strike } from './guard'
import { errorText, noteForModel } from './state'
import { SUB5_AGENT, sub5Prompt, workerSpec } from './sub5'
import { buildPrompt, cleanOutput, findSecret, TRANSLATE_SCHEMA } from './translate'
import type { TranslateInput } from './translate'
import {
  describeSources,
  effortLevel,
  MODEL_BUTTONS,
  modelFamily,
  parseAccountUsage,
  planSwitch,
  shownPercent,
  usageSegments,
} from './usage'
import type { Family, Segment } from './usage'
import {
  advance,
  describeWatch,
  errorResult,
  ghArgs,
  newWatch,
  notice,
  parseTarget,
  prResult,
  runResult,
  urlResult,
} from './watch'
import type { CheckResult, PrView, RunItem, WatchSettings } from './watch'

type Engine = EngineInterface

const WATCH_TOOL = 'mcp__deckhand__watch_deploy'
const TRANSLATE_TOOL = 'mcp__deckhand__agy_translate'
const CODEX_PANE = 'deckhand-codex'

const ROUTING = [
  "deckhand (the user's own mod):",
  `- To wait for a PR, CI run, merge or deploy, call ${WATCH_TOOL} once and end your turn. Never poll with sleep loops, \`gh run watch\`, \`gh pr checks --watch\` or repeated gh/curl status checks; the mod polls locally, applies the 3-strike stop rule and notifies the user.`,
  `- To translate i18n strings, docs or copy, call ${TRANSLATE_TOOL} (agy, localized-wording standard), then review terms and format before using the result. Never put secrets in it.`,
  '- Commit messages and PR descriptions carry no Co-Authored-By trailer and no "Generated with Claude Code" footer.',
].join('\n')

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

// ── Deploy watch: the engine side ───────────────────────────────────────────

async function checkWatch($: Engine, w: Watch): Promise<CheckResult> {
  try {
    if (w.kind === 'url') {
      const res = await $.http.fetch(w.target, { headers: { 'cache-control': 'no-cache' } })
      // The content decides, not etag or last-modified: nodes of one CDN disagree on those.
      return urlResult(w, res.status, fingerprintBody(headerOf(res.headers, 'content-type'), res.text), res.text)
    }
    const ran = await $.process.run([await resolveBin($, 'gh'), ...ghArgs(w), ...(w.repo ? ['--repo', w.repo] : [])], {
      cwd: w.cwd,
      timeoutMs: 60_000,
    })
    if (ran.exitCode !== 0) {
      return errorResult(((ran.stderr || ran.stdout).trim().split('\n')[0] ?? '').slice(0, 160) || `gh exited ${ran.exitCode}`)
    }
    const json = JSON.parse(ran.stdout) as unknown
    if (w.kind === 'pr') return prResult(json as PrView)
    return runResult(Array.isArray(json) ? (json as RunItem[]) : [json as RunItem])
  } catch (error) {
    return errorResult(errorText(error).slice(0, 160))
  }
}

function schedule($: Engine, w: Watch, s: WatchSettings) {
  timers.get(w.id)?.cancel()
  timers.delete(w.id)
  if (w.status !== 'watching') return
  timers.set(
    w.id,
    $.clock.after(Math.max(1000, w.intervalMs), () => void runCheck($, w.id, s)),
  )
}

async function runCheck($: Engine, id: string, s: WatchSettings): Promise<Watch | undefined> {
  const current = (await read($, watchesAtom)).find(w => w.id === id)
  if (!current || current.status !== 'watching') return current
  const result = await checkWatch($, current)
  const next = advance(current, result, await $.clock.now(), s)
  await update($, watchesAtom, list => list.map(w => (w.id === id ? next : w)))
  schedule($, next, s)
  if (next.status !== 'watching') {
    const { toast, note } = notice(next)
    $.ui.toast(toast, { timeoutMs: 15_000 })
    await $.session.append(noteForModel(note)).catch(() => undefined)
    if (next.status === 'done' && result.followUp) {
      await startWatch($, result.followUp, { startedBy: current.startedBy, repo: current.repo }, s)
    }
  }
  return next
}

async function startWatch(
  $: Engine,
  raw: string,
  options: { expect?: string; startedBy: 'user' | 'model'; repo?: string },
  s: WatchSettings,
): Promise<Watch | string> {
  const parsed = parseTarget(raw)
  if (!parsed) {
    return `無法辨識監看目標「${raw}」。支援：#128、pr:128、run:123、sha:<commit>、GitHub PR／Actions 網址、https:// 網址。`
  }
  const t = !parsed.repo && options.repo ? { ...parsed, repo: options.repo } : parsed
  const existing = (await read($, watchesAtom)).find(
    w => w.status === 'watching' && w.kind === t.kind && w.target === t.target && w.repo === t.repo,
  )
  if (existing) return existing
  const now = await $.clock.now()
  const watch = newWatch(t, `${t.kind}-${now.toString(36)}`, await $.session.cwd(), now, s, {
    expect: options.expect || undefined,
    startedBy: options.startedBy,
  })
  await update($, bandHiddenAtom, () => false)
  await update($, watchesAtom, list => [...list.slice(-7), watch])
  return (await runCheck($, watch.id, s)) ?? watch
}

async function stopWatches($: Engine, which: string) {
  const hits = (await read($, watchesAtom)).filter(
    w => w.status === 'watching' && (which === 'all' || w.id === which || w.label === which || w.target === which),
  )
  for (const w of hits) {
    timers.get(w.id)?.cancel()
    timers.delete(w.id)
  }
  await update($, watchesAtom, all =>
    all.map(w => (hits.some(h => h.id === w.id) ? { ...w, status: 'stopped' as const, reason: '使用者手動停止' } : w)),
  )
  return hits.length
}

async function clearFinished($: Engine) {
  await update($, watchesAtom, list => list.filter(w => w.status === 'watching'))
}

async function resumeWatches($: Engine, s: WatchSettings) {
  const now = await $.clock.now()
  for (const w of await read($, watchesAtom)) {
    if (w.status === 'watching') schedule($, { ...w, intervalMs: Math.max(1000, w.nextAt - now) }, s)
  }
}

// ── Codex inbox and handoff ─────────────────────────────────────────────────

async function loadCodexThreads($: Engine): Promise<CodexThread[]> {
  await update($, codexLoadingAtom, () => true)
  try {
    const [, ...args] = threadsArgv($.plugin.root, await $.session.root(), await read($, codexAllAtom))
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
  return $.process.run(
    [await resolveBin($, 'python3'), `${$.plugin.root}/bin/handoff-state.py`, ...args, '--cwd', await $.session.cwd()],
    { stdin, timeoutMs: 60_000 },
  )
}

const lastLine = (output: string) => output.trim().split('\n').pop() ?? ''

/**
 * Keeps ~/.agent-handoff/bin/handoff-state.py equal to the mod's copy: Codex's AGENTS.md names that
 * path, so it must not go stale when the mod is updated. The folder is made private (700) when new.
 */
async function syncSharedTool($: Engine) {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const source = await $.fs.read(`${$.plugin.root}/bin/handoff-state.py`)
    const target = `${home}/.agent-handoff/bin/handoff-state.py`
    if ((await $.fs.exists(target)) && (await $.fs.read(target)) === source) return
    await $.process.run(['mkdir', '-p', '-m', '700', `${home}/.agent-handoff`])
    await $.process.run(['mkdir', '-p', `${home}/.agent-handoff/bin`])
    await $.fs.write(target, source)
  } catch (error) {
    $.ui.log(`deckhand: 無法更新共用交接工具 ~/.agent-handoff/bin/handoff-state.py（${errorText(error)}）`)
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
 * "Weekly · all models" is nowhere in the engine's figures, so the account's own usage is asked for,
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
      $.ui.toast(`7d 讀不到帳號用量（${status}）。執行 /usage-raw 看原因。`, { timeoutMs: 12_000 })
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
  })
}

const LIMIT_NAME: Readonly<Record<string, string>> = {
  fiveHour: '5 小時額度',
  fable: 'Fable 每週額度',
  weekly: '每週額度（所有模型）',
}

/** One toast per limit and level, for the highest level crossed; it speaks again after the window resets. */
async function warnWhenHigh($: Engine, warnAt: number, warned: Set<string>) {
  for (const s of await currentSegments($, warnAt, false)) {
    if (s.percent === null) continue
    const crossed = [95, warnAt].find(level => s.percent! >= level)
    if (crossed === undefined) continue
    const key = `${s.id}@${crossed}@${s.resetsAt ?? ''}`
    if (warned.has(key)) continue
    warned.add(key)
    if (crossed === 95) warned.add(`${s.id}@${warnAt}@${s.resetsAt ?? ''}`)
    const reset = s.resetsAt ? `，${s.resetsAt.slice(11, 16)} UTC 重置` : ''
    $.ui.toast(`⚠️ ${LIMIT_NAME[s.id] ?? s.id}已達 ${shownPercent(s.percent)}%${reset}。建議收尾、改用較小模型，或把輕量任務外派 agy。`, {
      timeoutMs: 20_000,
    })
  }
}

// ── Model buttons ───────────────────────────────────────────────────────────

/**
 * A click on O / F / S / H: `/model <family>` as typed, then the effort the last turn ran at is put back,
 * because switching models otherwise loads the new model's own saved level. Haiku takes no effort.
 */
async function switchModel($: Engine, family: Family, isWorking: boolean) {
  if (isWorking) {
    $.ui.toast('這一輪還在執行，等它結束再切換模型。')
    return
  }
  const current = await $.session.model()
  const plan = planSwitch(current, family, await read($, contextTokensAtom))
  if (!plan.ok) {
    $.ui.toast(plan.reason)
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
    $.ui.toast(`沒有切換成功：${said || '原因不明'}`)
    return
  }
  let effortNote = ''
  if (level) {
    try {
      // Say so when this version has no /effort: running it would not throw, and "kept" would be a claim.
      const commands = await $.command.list()
      if (!commands.some(c => c.name === 'effort')) throw new Error('這個版本沒有 /effort 指令')
      await $.command.run({ command: 'effort', args: level })
      effortNote = `，effort 維持 ${level}`
    } catch (error) {
      effortNote = `（effort 沒能維持在 ${level}：${errorText(error)}）`
    }
  }
  $.ui.toast(`已切換到 ${after}${effortNote}`)
}

// ── Sub5 ────────────────────────────────────────────────────────────────────

let lastSub5At = 0

type Sub5Config = { max: number; model: string; effort: string }

/** The Sub5 button and `/sub5`: hands the main agent the flow as the user's own instruction. */
async function startSub5($: Engine, note: string, isWorking: boolean, cfg: Sub5Config) {
  const now = await $.clock.now()
  if (now - lastSub5At < 8_000) {
    $.ui.toast('Sub5 剛送出，請稍候。')
    return false
  }
  lastSub5At = now
  $.ui.toast(isWorking ? 'Sub5 已排入佇列：這一輪結束後開始。' : 'Sub5 已送出：拆分 → 派工 → 整合 → 清理。', { timeoutMs: 8_000 })
  try {
    await $.prompt.submit({ text: sub5Prompt({ ...cfg, tool: `${$.plugin.root}/bin/sub5.py`, note }), asUser: true })
  } catch (error) {
    lastSub5At = 0
    $.ui.toast(`Sub5 沒有送出：${errorText(error)}`)
    return false
  }
  return true
}

// ── Delegate: CL / CS / CA / CR / GF ────────────────────────────────────────

let lastDelegateAt = 0

/**
 * A click on CL / CS / CA / CR / GF, or `/delegate`: hands the main agent one delegation to an outside model,
 * as the user's own instruction. The task is `task` when one is given, else (`useDraft`) the draft in the
 * prompt box, else the conversation's current work. This never touches the main agent's own model or effort.
 */
async function startDelegate($: Engine, key: string, task: string, isWorking: boolean, useDraft: boolean) {
  const target = delegateTarget(key)
  if (!target) return false
  const now = await $.clock.now()
  if (now - lastDelegateAt < 8_000) {
    $.ui.toast('外派剛送出，請稍候。')
    return false
  }
  lastDelegateAt = now
  let text = task.trim()
  let draft = ''
  if (!text && useDraft) {
    // Only a surface that gives the plugin its prompt box has a draft to read; the others read ''.
    draft = (await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))).text.trim()
    text = draft
  }
  // The draft leaves the box now, not after the turn: `submit` waits for the turn, and a draft left
  // standing could be sent a second time.
  if (draft) await $.prompt.fill({ text: '' }).catch(() => undefined)
  const source = draft ? '用輸入框的文字當任務' : text ? '任務是指令帶的文字' : '沒有任務文字，外派目前對話中的工作'
  $.ui.toast(
    `${target.key}：${isWorking ? '已排入佇列，這一輪結束後外派給' : '已外派給'} ${delegateLabel(target)}，${source}。`,
    { timeoutMs: 10_000 },
  )
  try {
    await $.prompt.submit({ text: delegatePrompt({ target, tool: `${$.plugin.root}/bin/delegate.py`, task: text }), asUser: true })
  } catch (error) {
    lastDelegateAt = 0
    if (draft) await $.prompt.fill({ text: draft }).catch(() => undefined)
    $.ui.toast(`${target.key} 沒有送出：${errorText(error)}`)
    return false
  }
  return true
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const limit = Math.max(1, Math.round(Number(options.noProgressLimit ?? 3)))
  const settings: WatchSettings = {
    baseMs: Math.max(15, Number(options.pollSeconds ?? 90)) * 1000,
    // A watch that stops after one look watches nothing: at least two identical results.
    limit: Math.max(2, limit),
    stallMs: Math.max(0, Number(options.stallMinutes ?? 10)) * 60_000,
  }
  const stallMinutes = Math.round(settings.stallMs / 60_000)
  const stopRule = `${settings.limit} identical results in a row${stallMinutes > 0 ? ` and no change for ${stallMinutes} minutes` : ''}`
  const stopRuleZh = `連續 ${settings.limit} 次結果相同${stallMinutes > 0 ? `且 ${stallMinutes} 分鐘沒有變化` : ''}`
  const warnAt = Number(options.usageWarnPercent ?? 80)
  const agyModel = text(options.agyModel) || 'gemini-3.8-flash-medium'
  const strikes = new Map<string, Strike>()
  const warned = new Set<string>()
  const sub5: Sub5Config = {
    max: Math.min(8, Math.max(1, Math.round(Number(options.sub5Max ?? 5)))),
    model: text(options.sub5Model) || 'sonnet',
    effort: effortLevel(options.sub5Effort) ?? 'max',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'watch-deploy',
      description: `在背景監看 PR／CI／部署網址（不耗 token，${stopRuleZh}就自動停止）`,
      argumentHint: '<#PR | run:ID | sha:COMMIT | URL> [expect=文字] | stop [id|all] | clear',
    })
    await $.command.register({ name: 'handoff', description: '產生交給 Codex 的交接文件並複製接手指令', argumentHint: '[補充說明]' })
    await $.command.register({ name: 'codex', description: '開啟 Codex 收件匣：列出本專案最近的 Codex thread', argumentHint: '[all]' })
    await $.command.register({ name: 'codex-latest', description: '把本專案最新一則 Codex 回覆帶入輸入框' })
    await $.command.register({ name: 'handoff-in', description: '讀取 Codex 寫給 Claude 的最新交接文件，帶入輸入框' })
    await $.command.register({
      name: 'sub5',
      description: `把目前任務拆成最多 ${sub5.max} 項獨立工作，平行交給 sub agent，整合後清理（等同 Sub5 按鈕）`,
      argumentHint: '[補充說明]',
    })
    await $.command.register({
      name: 'delegate',
      description: `把任務外派給其他 AI 模型（${DELEGATES.map(t => t.key).join('／')}，等同按鈕），外派模型唯讀，結果由本對話整合總結`,
      argumentHint: `<${DELEGATES.map(t => t.key).join('|')}> [任務說明]`,
    })
    await $.command.register({ name: 'usage-raw', description: '列出狀態列用量的原始來源（引擎回報與帳號用量），用來對照用量頁' })
    await $.agent.register(workerSpec(sub5)).catch(error => $.ui.log(`deckhand: 無法登記 ${SUB5_AGENT}（${errorText(error)}）`))
    await $.tool.register({
      name: 'watch_deploy',
      description:
        'Watch a GitHub PR, an Actions run, all CI runs of a commit, or a deployed URL in the background, without spending tokens. ' +
        'Use this INSTEAD of sleep/poll loops, `gh run watch`, `gh pr checks --watch` or repeated gh/curl status checks. ' +
        'target: "#128", "run:123", "sha:<commit>", a GitHub PR or Actions run URL, or an https URL. ' +
        'expect (URL only, strongly recommended): text whose appearance means the new version is live (a commit sha, a version string). ' +
        'Without it the watch compares the page itself and needs two checks to confirm a change. ' +
        `Returns the current state at once. When the watch finishes, or stops (${stopRule}), the user gets a toast and a [deckhand] note is added to this conversation. ` +
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
    await $.tool.register({
      name: 'agy_translate',
      description:
        'Translate or localize text (i18n JSON/TS strings, Markdown docs, UI and marketing copy) with agy (Gemini Flash). ' +
        'The prompt enforces a localization standard: the idiomatic wording native speakers use in software and web products, never literal dictionary senses ' +
        '(e.g. "fresh" → 全新/最新, not 新鮮), Taiwan vocabulary for zh-TW, and placeholders, code, URLs and markup kept intact. ' +
        'Review the output before using it. Never pass secrets, .env content, tokens or customer data.',
      inputSchema: TRANSLATE_SCHEMA as unknown as Record<string, unknown>,
    })
    // The usage readout lives in the band above the prompt now: take down the old status line.
    $.ui.status(undefined)
    await syncSharedTool($)
    await resumeWatches($, settings)
    await loadUsage($).catch(() => undefined)
    await refreshModel($)
    void refreshAccountUsage($, true).catch(() => undefined)
    return next(e)
  })

  // ── Phase 1: deploy / PR / CI watch ─────────────────────────────────────

  on('command.run', { command: 'watch-deploy' }, async ($, e) => {
    const args = e.args.trim()
    if (args === '' || args === 'list') {
      const list = await read($, watchesAtom)
      return {
        text: list.length
          ? list.map(describeWatch).join('\n')
          : '目前沒有監看項目。用法：/watch-deploy #128、/watch-deploy https://example.com expect=abc1234',
      }
    }
    if (args === 'clear') {
      await clearFinished($)
      return { text: '已清除完成與停止的監看項目。' }
    }
    const stop = args.match(/^stop(?:\s+(.+))?$/)
    if (stop) {
      const count = await stopWatches($, stop[1]?.trim() || 'all')
      return { text: count ? `已停止 ${count} 個監看。` : '沒有符合的監看項目。' }
    }
    const expect = args.match(/\s+expect[=:]\s*(.+)$/)
    const target = expect ? args.slice(0, expect.index) : args
    const watch = await startWatch($, target, { expect: expect?.[1]?.trim(), startedBy: 'user' }, settings)
    return { text: typeof watch === 'string' ? watch : `開始監看 ${describeWatch(watch)}` }
  })

  on('tool.call', { tool: WATCH_TOOL }, async ($, e) => {
    const args = e as unknown as { target?: unknown; expect?: unknown }
    const target = text(args.target).trim()
    if (!target) return { deny: 'deckhand: watch_deploy needs a target.' }
    const watch = await startWatch($, target, { expect: text(args.expect).trim(), startedBy: 'model' }, settings)
    if (typeof watch === 'string') return { deny: watch }
    const tail =
      watch.status === 'watching'
        ? `已在背景監看。現在結束這一輪，不要再輪詢；完成或停止（${stopRuleZh}）時，使用者會收到通知，對話也會多一則 [deckhand] 註記。`
        : '監看已結束，依結果繼續。'
    return { result: `${describeWatch(watch)}\n${tail}` }
  }).catch((_$, _e, next) => ({ deny: `deckhand: watch_deploy 內部錯誤（${errorText(next.error)}）。請向使用者回報，不要改用輪詢。` }))

  // The band above the prompt: the running watches, then the control row: the usage readout
  // (5h · fb · 7d · ctx), the model buttons O / F / S / H, Sub5, and the delegate buttons CL / CS / CA / CR / GF.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const watches = await read($, watchesAtom)
    const hasWatches = watches.length > 0 && !(await read($, bandHiddenAtom))
    const hasFinished = watches.some(w => w.status !== 'watching')
    const segments = await currentSegments($, warnAt, true)
    const family = modelFamily(await read($, modelAtom))
    const isWorking = e.props.isWorking
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
                {w.status === 'watching' ? ` · 第 ${w.checks} 次` : ''}
              </Text>
              {w.status === 'watching' && (
                <Button key={`stop-${w.id}`} label="停止" onPress={() => void stopWatches($, w.id)} />
              )}
            </Box>
          ))}
        {hasWatches && (
          <Box gap={1}>
            {hasFinished && <Button key="clear" label="清除已結束" onPress={() => void clearFinished($)} />}
            <Button key="hide" label="隱藏監看" onPress={() => void update($, bandHiddenAtom, () => true)} />
          </Box>
        )}
        <Box gap={1} flexWrap="wrap">
          {segments.map((s, i) => (
            <Text
              key={`u-${s.id}`}
              color={s.level === 'high' ? 'red' : s.level === 'warn' ? 'yellow' : undefined}
              dimColor={s.level === 'ok' || s.level === 'unknown'}
            >
              {s.text}
              {i < segments.length - 1 ? ' ·' : ''}
            </Text>
          ))}
          {MODEL_BUTTONS.map(b => (
            <Button
              key={`m-${b.key}`}
              label={b.key}
              variant={family === b.family ? 'primary' : 'secondary'}
              dimColor={family !== b.family}
              onPress={() => void switchModel($, b.family, isWorking)}
            />
          ))}
          <Button key="sub5" label="Sub5" variant="secondary" onPress={() => void startSub5($, '', isWorking, sub5)} />
          {DELEGATES.map(t => (
            <Button
              key={`d-${t.key}`}
              label={t.key}
              variant="secondary"
              onPress={() => void startDelegate($, t.key, '', isWorking, true)}
            />
          ))}
        </Box>
      </Box>
    )
  })

  // ── Phase 2: Claude ↔ Codex ─────────────────────────────────────────────

  // Codex's file is read by the tool, which compares its recorded git facts with the repo as it is
  // now; the differences go into the prompt, so the model starts from them instead of re-deriving.
  on('command.run', { command: 'handoff-in' }, async $ => {
    const ran = await handoffTool($, ['check', '--from', 'codex', '--to', 'claude', '--format', 'json'])
    const checked = parseChecked(ran.stdout)
    if (!checked) return { text: `交接檢查失敗：${lastLine(ran.stderr || ran.stdout) || `exit ${ran.exitCode}`}` }
    if ('error' in checked) {
      return {
        text:
          checked.error === 'missing'
            ? `還沒有 Codex 寫給 Claude 的交接文件：${checked.path}\n請在 Codex 說「交接給 Claude」。`
            : `這個檔案不是交接工具寫的（沒有 front matter），請直接閱讀內容：${checked.path}`,
      }
    }
    await $.prompt.fill({ text: checked.nextPrompt })
    return { text: `${checked.report}\n\n已把接手指令（含上述差異）帶入輸入框，確認後送出。` }
  })

  // The model writes only the narrative; the tool adds the git facts from real git, masks secrets,
  // and names the file, the same way for Codex.
  on('command.run', { command: 'handoff' }, async ($, e) => {
    const forked = await $.model.fork({ prompt: HANDOFF_PROMPT(e.args.trim()) })
    if (!forked.isAnswered) return { text: `交接文件產生失敗：${forked.reason}` }
    const ran = await handoffTool($, ['write', '--from', 'claude', '--to', 'codex'], unfence(forked.text))
    const written = ran.exitCode === 0 ? parseWritten(ran.stdout) : null
    if (!written) return { text: `交接文件寫入失敗：${lastLine(ran.stderr || ran.stdout) || `exit ${ran.exitCode}`}` }
    const copied = await $.ui.copy({ text: written.nextPrompt }).catch(() => ({ isCopied: false as const }))
    return {
      text: [
        `交接文件：${written.path}`,
        stateLine(written.state),
        ...(written.redacted > 0 ? [`已遮蔽 ${written.redacted} 處疑似機密（<REDACTED>）`] : []),
        `${copied.isCopied ? '已複製' : '請複製'}以下 Codex 指令：`,
        '',
        written.nextPrompt,
      ].join('\n'),
    }
  })

  on('command.run', { command: 'codex' }, async ($, e) => {
    await update($, codexAllAtom, () => e.args.trim() === 'all')
    await $.ui.open({ id: CODEX_PANE, title: 'Codex 收件匣' })
    void loadCodexThreads($)
    return { text: '已開啟 Codex 收件匣。' }
  })

  on('command.run', { command: 'codex-latest' }, async $ => {
    await update($, codexAllAtom, () => false)
    const [latest] = await loadCodexThreads($)
    if (!latest) return { text: `本專案近 7 天沒有 Codex thread。${(await read($, codexErrorAtom)) ?? ''}` }
    await $.prompt.fill({ text: pastePrompt(latest) })
    return { text: `已把 Codex thread「${latest.name}」的最新回覆帶入輸入框，確認後送出。` }
  })

  on('ui.render', { component: 'Pane', requestId: CODEX_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const threads = await read($, codexThreadsAtom)
    const isLoading = await read($, codexLoadingAtom)
    const isAll = await read($, codexAllAtom)
    const error = await read($, codexErrorAtom)
    const now = await $.clock.now()
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 30) - 4) / 5))

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1}>
          <Text bold>{isAll ? '全部專案' : '本專案'} · 近 7 天</Text>
          <Button key="refresh" label="重新整理" onPress={() => void loadCodexThreads($)} />
          <Button
            key="scope"
            label={isAll ? '只看本專案' : '看全部專案'}
            onPress={async () => {
              await update($, codexAllAtom, all => !all)
              await loadCodexThreads($)
            }}
          />
        </Box>
        {isLoading && <Text dimColor>讀取中…</Text>}
        {error !== null && <Text color="red">讀取失敗：{error}</Text>}
        {!isLoading && error === null && threads.length === 0 && <Text dimColor>沒有符合的 Codex thread。</Text>}
        {threads.slice(0, room).map((t, i) => (
          <Box key={`t-${i}`} flexDirection="column">
            <Text bold wrap="truncate">
              {t.name}
            </Text>
            <Text dimColor wrap="truncate">
              {ago(t.updatedAt, now)} · {t.cwd.split('/').slice(-2).join('/')}
            </Text>
            <Text wrap="truncate">{t.lastAssistant.replace(/\s+/g, ' ').slice(0, 200)}</Text>
            <Box gap={1}>
              <Button key={`fill-${i}`} label="帶入輸入框" onPress={() => void $.prompt.fill({ text: pastePrompt(t) })} />
              <Button
                key={`copy-${i}`}
                label="複製回覆"
                onPress={press => void $.ui.copy({ text: t.lastAssistant, surface: press.surface })}
              />
            </Box>
          </Box>
        ))}
      </Box>
    )
  })

  // ── Phase 3: guards, translation, usage, routing ────────────────────────

  on('prompt.submit', async ($, e, next) => {
    // CLAUDE.md: a stopped check resumes only after the user speaks again.
    strikes.clear()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const notes: string[] = []
    const stripped = stripAttribution(e.command)
    const command = stripped ?? e.command
    if (stripped !== null) {
      notes.push('deckhand 已移除 Co-Authored-By／Generated with Claude Code 字樣（使用者規則：不加 attribution）。')
    }
    const wait = blockingWait(command)
    if (wait) {
      return {
        deny: `deckhand：不要用「${wait}」阻塞等待。改呼叫 ${WATCH_TOOL}（target 填 PR 編號、run:ID、sha:COMMIT 或網址）在背景監看，然後結束這一輪。`,
      }
    }
    const key = statusKey(command)
    if (key && (strikes.get(key)?.count ?? 0) >= limit) {
      return {
        deny: `deckhand：這項檢查已連續 ${limit} 次結果相同（CLAUDE.md 3 次規則），已停止。請向使用者回報目前狀態、卡住原因與需要的下一步，然後結束回合；或改用 ${WATCH_TOOL}。`,
      }
    }
    const ran = await next(stripped === null ? e : { ...e, command })
    if (ran.deny !== undefined) return ran
    if (key) {
      const count = recordStrike(strikes, key, normalizeOutput(ran.text ?? ''))
      if (count >= limit) {
        notes.push(`deckhand：這項檢查已連續 ${count} 次結果相同。依 CLAUDE.md 規則停止重複檢查，回報狀態給使用者。`)
      }
    }
    return notes.length ? { ...ran, context: [...(ran.context ?? []), ...notes] } : ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TRANSLATE_TOOL }, async ($, e) => {
    const raw = e as unknown as Record<string, unknown>
    const input: TranslateInput = {
      text: text(raw.text),
      target: text(raw.target).trim(),
      source: text(raw.source).trim() || undefined,
      context: text(raw.context).trim() || undefined,
      glossary: Array.isArray(raw.glossary) ? raw.glossary.filter((g): g is string => typeof g === 'string') : undefined,
    }
    if (!input.text.trim() || !input.target) return { deny: 'deckhand: agy_translate needs text and target.' }
    if (findSecret(input.text) || findSecret(input.context ?? '')) {
      return { deny: 'deckhand：內容疑似含 secret／token／私鑰，依規則不送進 agy。請先把該值換成 <REDACTED>，或自行翻譯。' }
    }
    try {
      const ran = await $.process.run(
        [await resolveBin($, 'agy'), '--model', agyModel, '--print-timeout=5m', '--disable-slash-commands', `-p=${buildPrompt(input)}`],
        { timeoutMs: 330_000 },
      )
      const out = cleanOutput(ran.stdout, input.text)
      if (ran.exitCode !== 0 || !out) {
        const why = (ran.stderr || ran.stdout).trim().split('\n').slice(-3).join(' ') || `exit ${ran.exitCode}`
        return { deny: `agy 翻譯失敗（${why}）。請改由你自行翻譯，並遵守在地化用語標準。` }
      }
      return {
        result: `${out}\n\n---\n[deckhand] 以上由 agy（${agyModel}）依在地化用語標準翻譯。採用前檢查術語、placeholder 與格式。`,
      }
    } catch (error) {
      return { deny: `agy 無法執行（${errorText(error)}）。請改由你自行翻譯，並遵守在地化用語標準。` }
    }
  }).catch((_$, _e, next) => ({ deny: `agy_translate 內部錯誤（${errorText(next.error)}）。請改由你自行翻譯，並遵守在地化用語標準。` }))

  // The engine measures the session after each main-thread turn and when a limit moves a whole point:
  // the readout is pushed to, not polled.
  on('session.measure', async ($, e, next) => {
    await storeUsage($, e)
    await refreshModel($)
    if (e.changed.includes('rateLimits')) void refreshAccountUsage($).catch(() => undefined)
    await warnWhenHigh($, warnAt, warned)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The effort the last turn really ran at (after any downgrade the model needed): what a switch keeps.
  on('classic.Stop', async ($, e, next) => {
    const level = effortLevel(e.effort?.level)
    if (!e.agent_id && level) await update($, effortAtom, () => level)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A model typed by hand moves the lit button too.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e)
    await refreshModel($)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'usage-raw' }, async $ => {
    await loadUsage($).catch(() => undefined)
    await refreshAccountUsage($, true)
    const lines = describeSources(await read($, engineLimitsAtom), await read($, accountLimitsAtom), await $.clock.now())
    const shown = (await currentSegments($, warnAt, true)).map(s => s.text).join(' · ')
    return { text: [...lines, '', `狀態列目前顯示：${shown}`].join('\n') }
  })

  on('command.run', { command: 'sub5' }, async ($, e) => {
    const note = e.args.trim()
    // The engine refuses prompt.submit from inside a command hook (it would wait on the turn this hook
    // holds): a timer's callback is a later event, and submits from there.
    $.clock.after(10, () => void startSub5($, note, false, sub5).catch(() => undefined))
    return { text: 'Sub5 即將送出。' }
  })

  on('command.run', { command: 'delegate' }, async ($, e) => {
    const args = e.args.trim()
    const first = args.split(/\s+/)[0] ?? ''
    const target = delegateTarget(first)
    if (!target) {
      return {
        text: [
          '用法：/delegate <目標> [任務說明]',
          ...DELEGATES.map(t => `  ${t.key}  ${delegateLabel(t)}`),
          '沒有任務說明時，外派目前對話中最新、尚未完成的工作。外派模型一律唯讀，結果由本對話整合總結。',
        ].join('\n'),
      }
    }
    const task = args.slice(first.length).trim()
    // Same as /sub5: the engine refuses prompt.submit from inside a command hook, a timer submits later.
    $.clock.after(10, () => void startDelegate($, target.key, task, false, false).catch(() => undefined))
    return { text: `${target.key} 即將外派。` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'deckhand:routing', text: ROUTING, scope: 'session' as const }] }
  })
}

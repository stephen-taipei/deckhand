/** The usage readout and the model buttons: the 5h, weekly and context gauges, their warnings, and switching the main model while keeping its effort. */
import type { AccountLimits, EngineLimit, Family, Segment } from './usage'
import type { Engine } from './core'
import { describeSources, desktopModelArg, learnModelId, MODEL_BUTTONS, modelFamily, parseAccountUsage, planSwitch, scopedFamily, shownPercent, usageSegments } from './usage'
import type { Messages } from './i18n'
import type { On, RenderSurface } from 'claude-code'
import { TOAST } from './ui'
import { asRecord, cfg, knownScoped, msgs, rememberScoped } from './core'
import { atom, read, update } from 'claude-code'
import { errorText } from './state'

export async function storeUsage($: Engine, m: Measured) {
  await update($, engineLimitsAtom, () => m.rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt })))
  await update($, contextPercentAtom, () => m.context.percent ?? null)
  await update($, contextTokensAtom, () => m.context.tokens ?? null)
}

export async function refreshModel($: Engine) {
  const model = await $.session.model().catch(() => '')
  if (model) await update($, modelAtom, () => model)
  await rememberModelId($, model)
}

/** Full model ids the engine has named, by family: what the desktop model buttons send. Kept across sessions. */
export async function knownModelIds($: Engine): Promise<Partial<Record<Family, string>>> {
  const stored = asRecord(await $.store.get('modelIds').catch(() => undefined))
  const out: Partial<Record<Family, string>> = {}
  for (const b of MODEL_BUTTONS) {
    const id = stored[b.family]
    if (typeof id === 'string' && learnModelId(id)?.family === b.family) out[b.family] = id
  }
  return out
}

export async function rememberModelId($: Engine, text: string) {
  const learned = learnModelId(text)
  if (!learned) return
  const known = await knownModelIds($)
  if (known[learned.family] === learned.id) return
  await $.store.set('modelIds', { ...known, [learned.family]: learned.id }).catch(() => undefined)
}

/**
 * The weekly windows are nowhere in the engine's figures, so the account's own usage is asked for,
 * through the engine: it holds the credential and sets the header, the plugin never sees the secret.
 * Rare on purpose; a failure keeps the last good reading and backs off.
 */
export async function refreshAccountUsage($: Engine, force = false) {
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
      $.ui.toast((await msgs($)).usage.unreadable(status), { timeoutMs: TOAST.problem })
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
    const known = await knownScoped($)
    if (families.some(f => !known.includes(f))) {
      const merged = [...new Set([...known, ...families])]
      await rememberScoped($, merged)
    }
  } catch (error) {
    await fail(`error: ${errorText(error).slice(0, 80)}`)
  }
}

export async function loadUsage($: Engine) {
  await storeUsage($, await $.session.usage())
}

export async function currentSegments($: Engine, warnAt: number, withContext: boolean): Promise<Segment[]> {
  return usageSegments({
    engine: await read($, engineLimitsAtom),
    account: await read($, accountLimitsAtom),
    contextPercent: withContext ? await read($, contextPercentAtom) : null,
    now: await $.clock.now(),
    warnAt,
    knownScoped: await knownScoped($),
  })
}

export async function warnWhenHigh($: Engine) {
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
    $.ui.toast(m.usage.warn(limitName(s, m), shownPercent(s.percent), reset), { timeoutMs: TOAST.problem })
  }
}

/**
 * A /model ran (the command hook, or the app's own path reported by PostModelSwitch): when it is the one
 * a model button wrote, the effort the last turn ran at comes back, from a timer since a hook may not
 * run a command. The record is cleared on the first of the two events, so the effort is put back once.
 */
export async function settleSwitch($: Engine, requested: string) {
  const pending = pendingSwitch
  if (!pending) return
  const now = await $.clock.now()
  const asked = requested.trim().toLowerCase()
  const isOurs = asked === pending.alias.toLowerCase() || modelFamily(asked) === modelFamily(pending.alias)
  if (!isOurs) return
  pendingSwitch = null
  if (pending.level && now - pending.at < 10 * 60_000) {
    const level = pending.level
    $.clock.after(10, () => void (async () => {
      await restoreEffort($, level, await msgs($))
    })().catch(() => undefined))
  }
}

/** The session's model id, as the last switch or session start left it. */
export async function currentModel($: Engine) {
  return read($, modelAtom)
}

/** The effort the last main turn really ran at: what a model switch puts back. */
export async function rememberEffort($: Engine, level: string) {
  await update($, effortAtom, () => level)
}

export async function pressModel($: Engine, family: Family, isWorking: boolean, surface: RenderSurface) {
  const m = await msgs($)
  const current = await $.session.model().catch(() => '')
  const plan = planSwitch(current, family, await read($, contextTokensAtom), m)
  if (!plan.ok) {
    $.ui.toast(plan.reason, { timeoutMs: TOAST.problem })
    return
  }
  const name = MODEL_BUTTONS.find(b => b.family === family)!.name
  if (surface === 'desktop') {
    // The app's menu knows models by full id only: `/model opus` would leave it on "unsupported model".
    const target = desktopModelArg(plan.alias, await knownModelIds($))
    const command = `/model ${target}`
    const box = await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))
    if (box.text.trim() && !/^\/model\b/.test(box.text.trim())) {
      $.ui.toast(m.model.boxBusy, { timeoutMs: TOAST.problem })
      return
    }
    const level = plan.keepEffort ? await read($, effortAtom) : null
    const effort = level ? m.model.effortKept(level) : ''
    // Whichever way the command reaches the person, the effort comes back once they send it.
    pendingSwitch = { alias: target, level, at: await $.clock.now() }
    const filled = await $.prompt.fill({ text: command, mode: 'replace' }).catch(() => ({ isFilled: false }))
    if (filled.isFilled) {
      $.ui.toast(m.model.fillReady(name, command, effort), { timeoutMs: TOAST.action })
      return
    }
    const copied = await $.ui.copy({ text: command, surface }).catch(() => ({ isCopied: false }))
    $.ui.toast(copied.isCopied ? m.model.copied(name, command, effort) : m.model.fillFailed(command), { timeoutMs: TOAST.action })
    return
  }
  if (isWorking) {
    $.ui.toast(m.model.busy, { timeoutMs: TOAST.problem })
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
    $.ui.toast(m.model.failed(said), { timeoutMs: TOAST.problem })
    return
  }
  $.ui.toast(m.model.switched(after, level ? await restoreEffort($, level, m) : ''), { timeoutMs: TOAST.done })
}

/** Puts the effort back; says so when this version has no /effort, instead of claiming it was kept. */
export async function restoreEffort($: Engine, level: string, m: Messages) {
  try {
    const commands = await $.command.list()
    if (!commands.some(c => c.name === 'effort')) throw new Error(m.model.noEffortCommand)
    await $.command.run({ command: 'effort', args: level })
    return m.model.effortKept(level)
  } catch (error) {
    return m.model.effortNotKept(level, errorText(error))
  }
}

const engineLimitsAtom = atom({ plugin: 'deckhand', key: 'engineLimits' } as const, [] as EngineLimit[])

const accountLimitsAtom = atom({ plugin: 'deckhand', key: 'accountLimits' } as const, null as AccountLimits | null)

const contextPercentAtom = atom({ plugin: 'deckhand', key: 'contextPercent' } as const, null as number | null)

const contextTokensAtom = atom({ plugin: 'deckhand', key: 'contextTokens' } as const, null as number | null)

const modelAtom = atom({ plugin: 'deckhand', key: 'model' } as const, '')

const effortAtom = atom({ plugin: 'deckhand', key: 'effort' } as const, null as string | null)

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

const limitName = (s: Segment, m: Messages) =>
  s.id === 'fiveHour' ? m.usage.fiveHour : s.id === 'weekly' ? m.usage.weekly : m.usage.scoped(s.name ?? s.id)

/** The limits already warned about, so each warning is toasted once per window. */
const warned = new Set<string>()

/** A /model the desktop app is about to send for the person: the effort to put back once it ran. */
let pendingSwitch: { alias: string; level: string | null; at: number } | null = null

/** The hooks of this part of the plugin; register.tsx calls this first. */
export function registerModels(on: On) {
  on('session.measure', async ($, e, next) => {
    await storeUsage($, e)
    await refreshModel($)
    if (e.changed.includes('rateLimits')) void refreshAccountUsage($).catch(() => undefined)
    await warnWhenHigh($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A /model the person sent moves the lit button; one the model button wrote (desktop) also puts the
  // effort back, from a timer since a command hook may not run another command.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e)
    await rememberModelId($, result.text ?? '')
    await refreshModel($)
    await settleSwitch($, e.args)
    return result
  }).catch(($, e, next) => next(e))

  // The desktop app runs its /model itself, outside the command hook, and applies it to the engine
  // headlessly: this event is where the lit button moves and the effort comes back there.
  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, modelAtom, () => e.to_model)
    await rememberModelId($, e.to_model)
    await settleSwitch($, e.requested_model ?? e.to_model)
    return next(e)
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
}

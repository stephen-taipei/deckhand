/**
 * Pure logic of the usage readout and the model buttons: what each number is called, where it comes
 * from, and when a model switch is safe. No `$` here, so tests can call it.
 *
 * The numbers are the usage card's, from the same call the app makes: `GET /api/oauth/usage`. Its answer
 * has `five_hour` and `seven_day` ("Weekly · all models") as `{ utilization, resets_at }`, and a `limits`
 * list in which every `kind: "weekly_scoped"` entry names its model under `scope.model.display_name`
 * ("Weekly · Fable"). The card shows `Math.floor(utilization)`, so does this.
 *
 * The engine's own `rateLimits` (the last response's headers) is used for `5h` and nothing else: its
 * `seven_day` is the weekly window the answering model counts against, not a fixed one, so it is neither
 * "all models" nor "Fable" and never stands in for them.
 */

export type EngineLimit = { kind: string; percent: number; resetsAt?: string }

/** One window of the account's usage, as the usage API names it. */
export type AccountWindow = { key: string; label: string; percent: number; resetsAt?: string }

export type AccountLimits = {
  windows: AccountWindow[]
  fetchedAt: number
  /** `ok`, or why the account's usage could not be read (`no-credential`, `http-401`, ...). */
  status: string
  /** The answer as received, cut short, for `/usage-raw`. */
  raw?: string
}

export type Level = 'ok' | 'warn' | 'high' | 'unknown'

export type Segment = {
  id: 'fiveHour' | 'fable' | 'weekly' | 'context'
  text: string
  percent: number | null
  level: Level
  resetsAt?: string
}

const PERCENT_KEYS = ['utilization', 'percent_used', 'percentUsed', 'used_percentage', 'percent'] as const
const LABEL_KEYS = ['label', 'display_name', 'displayName', 'name', 'title'] as const
const NAME_KEYS = ['kind', 'type', 'key', 'id'] as const

const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const firstString = (o: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of keys) if (typeof o[key] === 'string' && o[key] !== '') return o[key] as string
  return undefined
}

const firstNumber = (o: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of keys) {
    const value = o[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

const clampPercent = (n: number) => Math.min(100, Math.max(0, n))

/** The model or surface a `limits[]` entry is scoped to: `scope.model.display_name`, else `scope.surface.display_name`. */
const scopeName = (o: Record<string, unknown>) => {
  const scope = asObject(o.scope)
  for (const kind of ['model', 'surface']) {
    const name = asObject(scope?.[kind])?.display_name
    if (typeof name === 'string' && name.trim() !== '') return name.trim()
  }
  return undefined
}

/** The usage card's number: it floors, so 2.6% reads 2%. */
export const shownPercent = (percent: number) => Math.floor(percent)

/**
 * Finds the usage windows in whatever shape the usage API answers: an object per window under its own
 * key (`{ five_hour: { utilization, resets_at } }`), a `limits` list whose entries name their model under
 * `scope` (`{ kind: 'weekly_scoped', percent, scope: { model: { display_name: 'Fable' } } }`), or a list of
 * windows that name themselves (`[{ label, percentUsed }]`). A window is any object that carries a
 * percentage; null ones are skipped.
 */
export const parseAccountUsage = (json: unknown, now: number, status = 'ok', raw?: string): AccountLimits | null => {
  const windows: AccountWindow[] = []
  const seen = new Set<unknown>()
  const walk = (value: unknown, key: string, depth: number) => {
    if (depth > 3 || value === null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        const o = asObject(item)
        walk(item, (o && firstString(o, NAME_KEYS)) || `${key}[${i}]`, depth + 1)
      })
      return
    }
    const o = value as Record<string, unknown>
    const percent = firstNumber(o, PERCENT_KEYS)
    if (percent !== undefined) {
      const scoped = scopeName(o)
      windows.push({
        key: scoped ? `${key}:${scoped}` : key,
        label: firstString(o, LABEL_KEYS) ?? scoped ?? key,
        percent: clampPercent(percent),
        resetsAt: firstString(o, ['resets_at', 'resetsAt']),
      })
      return
    }
    for (const [k, v] of Object.entries(o)) walk(v, k, depth + 1)
  }
  walk(json, '', 0)
  return windows.length > 0 ? { windows, fetchedAt: now, status, raw } : null
}

const isFable = (w: AccountWindow) => /fable/i.test(`${w.key} ${w.label}`)
const isWeeklyAll = (w: AccountWindow) =>
  !isFable(w) && (w.key === 'seven_day' || (/weekly|7.?day|每週/i.test(w.label) && /all models|所有模型/i.test(w.label)))
const isFiveHour = (w: AccountWindow) =>
  w.key === 'five_hour' || /(^|\W)(5|five)[- ]?hour|current session|工作階段/i.test(w.label)

/** A reading older than this is not shown as current. */
export const ACCOUNT_MAX_AGE_MS = 30 * 60_000

const levelOf = (percent: number | null, warnAt: number): Level =>
  percent === null ? 'unknown' : percent >= 95 ? 'high' : percent >= warnAt ? 'warn' : 'ok'

export type UsageInput = {
  engine: readonly EngineLimit[]
  account: AccountLimits | null
  contextPercent: number | null
  now: number
  warnAt: number
}

/**
 * The readout, in order: `5h`, `fb` (Weekly · Fable), `7d` (Weekly · all models), `ctx`, each as the usage
 * card shows it. `fb` and `7d` come from the account's usage alone and read `–` when it cannot be read
 * (a wrong number is worse than none); `5h` falls back to the engine's `five_hour`, which is that same
 * window. The context window is left out until it is known.
 */
export const usageSegments = (input: UsageInput): Segment[] => {
  const isFresh = input.account !== null && input.account.status === 'ok' && input.now - input.account.fetchedAt <= ACCOUNT_MAX_AGE_MS
  const windows = isFresh ? input.account!.windows : []
  const engineFive = input.engine.find(l => l.kind === 'five_hour')

  const five = windows.find(isFiveHour)
  const fable = windows.find(isFable)
  const weekly = windows.find(isWeeklyAll)

  const pick = (
    id: Segment['id'],
    label: string,
    percent: number | null | undefined,
    resetsAt: string | undefined,
  ): Segment => {
    const value = percent ?? null
    return {
      id,
      text: `${label} ${value === null ? '–' : `${shownPercent(value)}%`}`,
      percent: value,
      level: levelOf(value, input.warnAt),
      resetsAt,
    }
  }

  const segments = [
    pick('fiveHour', '5h', five?.percent ?? engineFive?.percent, five?.resetsAt ?? engineFive?.resetsAt),
    pick('fable', 'fb', fable?.percent, fable?.resetsAt),
    pick('weekly', '7d', weekly?.percent, weekly?.resetsAt),
  ]
  if (input.contextPercent !== null) segments.push(pick('context', 'ctx', input.contextPercent, undefined))
  return segments
}

/** The account's windows and the engine's, as they are, for `/usage-raw`. */
export const describeSources = (engine: readonly EngineLimit[], account: AccountLimits | null, now: number) => {
  const lines = ['引擎回報（$.session.usage，最近一次回應；只用 five_hour，seven_day 取決於回應的模型，不用）：']
  lines.push(...(engine.length ? engine.map(l => `  ${l.kind}  ${l.percent}%${l.resetsAt ? `  重置 ${l.resetsAt}` : ''}`) : ['  （沒有讀數）']))
  lines.push('', `帳號用量（/api/oauth/usage）：${account ? account.status : '尚未讀取'}${account ? `，${Math.round((now - account.fetchedAt) / 1000)} 秒前` : ''}`)
  if (account && account.status === 'ok') {
    lines.push(
      ...account.windows.map(
        w => `  ${w.key}  「${w.label}」  ${w.percent}%（用量頁顯示 ${shownPercent(w.percent)}%）${w.resetsAt ? `  重置 ${w.resetsAt}` : ''}`,
      ),
    )
    if (account.raw) lines.push('', `原始回應（截斷）：${account.raw}`)
  }
  return lines
}

// ── models ─────────────────────────────────────────────────────────────────

export type Family = 'opus' | 'fable' | 'sonnet' | 'haiku'

export const MODEL_BUTTONS: ReadonlyArray<{ key: string; family: Family; name: string }> = [
  { key: 'O', family: 'opus', name: 'Opus' },
  { key: 'F', family: 'fable', name: 'Fable' },
  { key: 'S', family: 'sonnet', name: 'Sonnet' },
  { key: 'H', family: 'haiku', name: 'Haiku' },
]

/** Which button a model id belongs to (`claude-sonnet-5-5`, `sonnet[1m]`, ...); null for a model with none. */
export const modelFamily = (model: string): Family | null => {
  const m = model.toLowerCase()
  return MODEL_BUTTONS.find(b => m.includes(b.family))?.family ?? null
}

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const effortLevel = (value: unknown): string | null =>
  typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value) ? value : null

/** Haiku's window is far smaller than the others': a long conversation does not fit in it. */
export const HAIKU_SAFE_TOKENS = 150_000

export type SwitchPlan =
  | { ok: true; alias: string; keepEffort: boolean }
  | { ok: false; reason: string }

/**
 * What a click on a model button does. The alias is the family name (`/model opus` takes the latest Opus),
 * with `[1m]` kept when the session runs on the 1M-token window, so that a switch never shrinks it.
 * Haiku takes no effort setting, so none is carried over to it.
 */
export const planSwitch = (current: string, target: Family, contextTokens: number | null): SwitchPlan => {
  const name = MODEL_BUTTONS.find(b => b.family === target)!.name
  if (modelFamily(current) === target) return { ok: false, reason: `目前已經是 ${name}。` }
  if (target === 'haiku' && contextTokens !== null && contextTokens > HAIKU_SAFE_TOKENS) {
    return {
      ok: false,
      reason: `目前 context 約 ${Math.round(contextTokens / 1000)}k tokens，Haiku 的視窗裝不下。請先 /compact，或開新的 session。`,
    }
  }
  const keepsLongWindow = /\[1m\]/i.test(current) && target !== 'haiku'
  return { ok: true, alias: keepsLongWindow ? `${target}[1m]` : target, keepEffort: target !== 'haiku' }
}

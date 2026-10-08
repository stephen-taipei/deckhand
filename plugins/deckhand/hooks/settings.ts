/**
 * The person's settings: what the ⚙ pane edits, kept in `$.store` across sessions. Personal choices
 * (models, efforts, CLI paths, the attribution rule) live here as data, not in the code. Pure: the
 * shape, the defaults and the clamping, so tests can read it.
 */
import type { DeckhandSettings, DelegateTarget, DelegateTool, Locale } from '../types'

export type { DelegateTarget, DelegateTool } from '../types'
export type Settings = DeckhandSettings

export const DELEGATE_TOOLS: readonly DelegateTool[] = ['codex', 'agent', 'agy']

/** Levels bin/delegate.py accepts. For agent and agy the effort is part of the model id: display only. */
export const DELEGATE_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export const SUB5_MODELS = ['sonnet', 'opus', 'fable', 'haiku'] as const
export const SUB5_EFFORTS = ['medium', 'high', 'xhigh', 'max'] as const
export const DELEGATE_SLOTS = 5

export const DEFAULT_DELEGATES: readonly DelegateTarget[] = [
  { key: 'CL', enabled: true, tool: 'codex', model: 'gpt-6-luna', effort: 'max', name: 'GPT-6 Luna' },
  { key: 'CS', enabled: true, tool: 'codex', model: 'gpt-6.1-sol', effort: 'medium', name: 'GPT-6.1 Sol' },
  { key: 'CA', enabled: true, tool: 'codex', model: 'gpt-6-astra', effort: 'medium', name: 'GPT-6 Astra' },
  { key: 'CR', enabled: true, tool: 'agent', model: 'grok-4.7-high', effort: 'high', name: 'Grok 4.7' },
  { key: 'GF', enabled: true, tool: 'agy', model: 'gemini-3.8-flash-high', effort: 'high', name: 'Gemini 3.8 Flash' },
]

/**
 * A first run's settings. The attribution guard is on only for someone whose Claude settings already
 * turn attribution off (`attribution.commit: ""`): stripping trailers is their rule, not everyone's.
 */
export const defaultSettings = (o: { attributionOff: boolean }): Settings => ({
  version: 1,
  language: 'auto',
  show: { usage: true, models: true, sub5: true, delegates: true, recap: true },
  delegates: DEFAULT_DELEGATES.map(d => ({ ...d })),
  sub5: { max: 5, model: 'sonnet', effort: 'max' },
  paths: { codexHome: '', codexBin: '', agentBin: '', agyBin: '' },
  guards: { attribution: o.attributionOff, polling: true, repeatLimit: 3 },
  watch: { pollSeconds: 90, stallMinutes: 10 },
  usage: { warnPercent: 80 },
  translate: { agyModel: 'gemini-3.8-flash-medium' },
})

export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]=,]{0,99}$/
export const LABEL = /^[A-Za-z0-9]{1,6}$/

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const num = (v: unknown, d: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : d
const str = (v: unknown, d: string, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : d)
/** A path is a path: no line breaks, no NUL, nothing a shell quote would have to fight. */
const path = (v: unknown, d: string) => {
  const s = str(v, d)
  return /[\n\r\0']/.test(s) ? d : s
}

export const normalizeTarget = (v: unknown, d: DelegateTarget): DelegateTarget => {
  const o = obj(v)
  const key = typeof o.key === 'string' && LABEL.test(o.key.trim()) ? o.key.trim().toUpperCase() : d.key
  const model = typeof o.model === 'string' && MODEL_ID.test(o.model.trim()) ? o.model.trim() : d.model
  const name = typeof o.name === 'string' && o.name.trim() && o.name.length <= 40 && !/[\n\r']/.test(o.name) ? o.name.trim() : d.name
  return {
    key,
    enabled: bool(o.enabled, d.enabled),
    tool: oneOf(o.tool, DELEGATE_TOOLS, d.tool),
    model,
    effort: oneOf(o.effort, DELEGATE_EFFORTS, d.effort as (typeof DELEGATE_EFFORTS)[number]),
    name,
  }
}

/** Whatever the store holds, read against `base`: unknown keys dropped, bad values kept at the base's. */
export const normalizeSettings = (raw: unknown, base: Settings, locales: readonly Locale[]): Settings => {
  const r = obj(raw)
  const show = obj(r.show)
  const sub5 = obj(r.sub5)
  const paths = obj(r.paths)
  const guards = obj(r.guards)
  const watch = obj(r.watch)
  const usage = obj(r.usage)
  const translate = obj(r.translate)
  const stored = Array.isArray(r.delegates) ? r.delegates : []
  const delegates = base.delegates.map((d, i) => normalizeTarget(stored[i], d))
  // Two buttons on one label would press the same target: the later one gets its slot's default back.
  const seen = new Set<string>()
  for (let i = 0; i < delegates.length; i++) {
    if (seen.has(delegates[i]!.key)) delegates[i] = { ...delegates[i]!, key: `${DEFAULT_DELEGATES[i]?.key ?? 'D'}${i + 1}`.slice(0, 6) }
    seen.add(delegates[i]!.key)
  }
  return {
    version: 1,
    language:
      r.language === 'auto'
        ? 'auto'
        : typeof r.language === 'string' && (locales as readonly string[]).includes(r.language)
          ? (r.language as Locale)
          : base.language,
    show: {
      usage: bool(show.usage, base.show.usage),
      models: bool(show.models, base.show.models),
      sub5: bool(show.sub5, base.show.sub5),
      delegates: bool(show.delegates, base.show.delegates),
      recap: bool(show.recap, base.show.recap),
    },
    delegates,
    sub5: {
      max: num(sub5.max, base.sub5.max, 1, 8),
      model: oneOf(sub5.model, SUB5_MODELS, base.sub5.model as (typeof SUB5_MODELS)[number]),
      effort: oneOf(sub5.effort, SUB5_EFFORTS, base.sub5.effort as (typeof SUB5_EFFORTS)[number]),
    },
    paths: {
      codexHome: path(paths.codexHome, base.paths.codexHome),
      codexBin: path(paths.codexBin, base.paths.codexBin),
      agentBin: path(paths.agentBin, base.paths.agentBin),
      agyBin: path(paths.agyBin, base.paths.agyBin),
    },
    guards: {
      attribution: bool(guards.attribution, base.guards.attribution),
      polling: bool(guards.polling, base.guards.polling),
      repeatLimit: num(guards.repeatLimit, base.guards.repeatLimit, 2, 10),
    },
    watch: {
      pollSeconds: num(watch.pollSeconds, base.watch.pollSeconds, 15, 600),
      stallMinutes: num(watch.stallMinutes, base.watch.stallMinutes, 0, 120),
    },
    usage: { warnPercent: num(usage.warnPercent, base.usage.warnPercent, 50, 99) },
    translate: {
      agyModel: typeof translate.agyModel === 'string' && MODEL_ID.test(translate.agyModel) ? translate.agyModel : base.translate.agyModel,
    },
  }
}

/** Reads one field by its path (`sub5.max`, `delegates.2.model`); undefined when there is none. */
export const fieldOf = (s: Settings, field: string): unknown =>
  field.split('.').reduce<unknown>((at, p) => (at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[p] : undefined), s)

/** Sets one field by its path (`sub5.max`, `delegates.2.model`), as a pane edit does. */
export const withField = (s: Settings, field: string, value: unknown): Settings => {
  const copy = JSON.parse(JSON.stringify(s)) as Record<string, unknown>
  const parts = field.split('.')
  let at: Record<string, unknown> | unknown[] = copy
  for (const p of parts.slice(0, -1)) {
    const next: unknown = (at as Record<string, unknown>)[p]
    if (next === null || typeof next !== 'object') return s
    at = next as Record<string, unknown>
  }
  ;(at as Record<string, unknown>)[parts[parts.length - 1]!] = value
  return copy as unknown as Settings
}

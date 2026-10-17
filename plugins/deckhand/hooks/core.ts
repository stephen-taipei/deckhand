/**
 * The core every part of the plugin shares: the settings and the language they resolve to, the ids of its
 * panes and tools. An atom lives in the one file that reads and writes it (the engine reads each file on its
 * own), so the rest of the plugin reaches these through the functions below.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Locale } from '../types'
import { LOCALES, messages, resolveLocale } from './i18n'
import type { Messages } from './i18n'
import { defaultSettings, normalizeSettings } from './settings'
import type { Settings } from './settings'

export type Engine = EngineInterface


const settingsAtom = atom({ plugin: 'deckhand', key: 'settings' } as const, null as Settings | null)
const localeAtom = atom({ plugin: 'deckhand', key: 'locale' } as const, 'en' as Locale)
const knownScopedAtom = atom({ plugin: 'deckhand', key: 'knownScoped' } as const, [] as string[])

export const asRecord = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/**
 * The person's settings from `$.store`, read against defaults that depend on their Claude settings
 * (the attribution guard), and the language they resolve to. Called at session start and on demand.
 */
export async function loadSettings($: Engine): Promise<Settings> {
  const claude = asRecord(await $.settings.read().catch(() => ({})))
  const base = defaultSettings({ attributionOff: asRecord(claude.attribution).commit === '' })
  const stored = await $.store.get('settings').catch(() => undefined)
  const s = normalizeSettings(stored, base, LOCALES)
  await update($, settingsAtom, () => s)
  const sys = await systemLanguage($)
  await update($, localeAtom, () => resolveLocale(s.language, claude.language, sys))
  const known = await $.store.get('knownScoped').catch(() => undefined)
  if (Array.isArray(known)) await update($, knownScopedAtom, () => known.filter((k): k is string => typeof k === 'string'))
  return s
}

export async function cfg($: Engine): Promise<Settings> {
  return (await read($, settingsAtom)) ?? loadSettings($)
}

/** For drawing: reads only (a render hook may not write state); defaults until the session has loaded them. */
export async function cfgForDrawing($: Engine): Promise<Settings> {
  return (await read($, settingsAtom)) ?? defaultSettings({ attributionOff: false })
}

/** The catalog for a handler: loads the settings first when the session has not, so the language is right. */
export async function msgs($: Engine): Promise<Messages> {
  if (!(await read($, settingsAtom))) await loadSettings($)
  return messages(await read($, localeAtom))
}

/** The catalog for drawing: reads only. */
export async function msgsForDrawing($: Engine): Promise<Messages> {
  return messages(await read($, localeAtom))
}

/** The language the plugin speaks now. */
export async function currentLocale($: Engine): Promise<Locale> {
  return read($, localeAtom)
}

/** Stores new settings and the language they resolve to; what else depends on them is the caller's to redo. */
export async function storeSettings($: Engine, next: Settings, claudeLanguage: unknown) {
  await update($, settingsAtom, () => next)
  await $.store.set('settings', next).catch(error => $.ui.log(`deckhand: settings not saved (${error instanceof Error ? error.message : String(error)})`))
  const sys = await systemLanguage($)
  await update($, localeAtom, () => resolveLocale(next.language, claudeLanguage, sys))
}

/** The per-model weekly windows this account has shown, so they read – rather than vanish while unreadable. */
export async function knownScoped($: Engine): Promise<string[]> {
  return read($, knownScopedAtom)
}

export async function rememberScoped($: Engine, families: string[]) {
  await update($, knownScopedAtom, () => families)
  await $.store.set('knownScoped', families).catch(() => undefined)
}

/** The system's language, read once: the locale environment, else macOS's first preferred language. */
let system: string | undefined

/**
 * What `auto` falls back to when Claude Code has no `language` setting: LC_ALL, LC_MESSAGES or LANG
 * (not C or POSIX), else, on macOS, where an app started from the Dock has no LANG, the first of
 * AppleLanguages (`zh-Hant-TW`). Empty when neither says.
 */
export async function systemLanguage($: Engine): Promise<string> {
  if (system !== undefined) return system
  system = ''
  try {
    // $.env.get takes a literal name, so the engine can list what the plugin reads.
    const values = [
      await $.env.get('LC_ALL').catch(() => undefined),
      await $.env.get('LC_MESSAGES').catch(() => undefined),
      await $.env.get('LANG').catch(() => undefined),
    ]
    for (const raw of values) {
      const value = (raw ?? '').trim()
      if (value && !/^(C|POSIX)([.@]|$)/i.test(value)) return (system = value)
    }
    // A terminal has LANG; the desktop app, started from the Dock, may not.
    if (!(await isDesktopApp($))) return system
    const ran = await $.process.run(['/usr/bin/defaults', 'read', '-g', 'AppleLanguages'], { timeoutMs: 5_000 })
    if (ran.exitCode === 0) system = ran.stdout.match(/"?([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)"?/)?.[1] ?? ''
  } catch {
    // No env or process here (tests, a sandbox): English.
  }
  return system
}

/** Absolute paths of CLIs: the desktop app's PATH may lack ~/.local/bin or Homebrew. */
const bins = new Map<string, string>()

export async function resolveBin($: Engine, name: string) {
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

/** The Claude desktop app starts the engine with this entrypoint; its own PR bar watches a bound PR's CI. */
export async function isDesktopApp($: Engine) {
  return (await $.env.get('CLAUDE_CODE_ENTRYPOINT').catch(() => undefined)) === 'claude-desktop'
}

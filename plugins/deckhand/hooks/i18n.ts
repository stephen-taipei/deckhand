/**
 * Which language the band, the panes, the toasts and the briefs speak. `auto` follows Claude Code's own
 * `language` setting, a free-text value (`正體中文`, `japanese`, `pt-BR`), so names and tags both count.
 * Pure: the catalogs are data, `messages(locale)` picks one; locales.ts lists the languages.
 */
import type { Locale } from '../types'
import { en } from './i18n/en'
import type { Messages } from './i18n/en'
import { ar } from './i18n/ar'
import { ca } from './i18n/ca'
import { cs } from './i18n/cs'
import { da } from './i18n/da'
import { de } from './i18n/de'
import { el } from './i18n/el'
import { es } from './i18n/es'
import { esMX } from './i18n/es-MX'
import { fi } from './i18n/fi'
import { fil } from './i18n/fil'
import { fr } from './i18n/fr'
import { he } from './i18n/he'
import { hi } from './i18n/hi'
import { hr } from './i18n/hr'
import { hu } from './i18n/hu'
import { id } from './i18n/id'
import { it } from './i18n/it'
import { ja } from './i18n/ja'
import { km } from './i18n/km'
import { ko } from './i18n/ko'
import { lo } from './i18n/lo'
import { ms } from './i18n/ms'
import { my } from './i18n/my'
import { nb } from './i18n/nb'
import { nl } from './i18n/nl'
import { pl } from './i18n/pl'
import { pt } from './i18n/pt'
import { ptBR } from './i18n/pt-BR'
import { ro } from './i18n/ro'
import { ru } from './i18n/ru'
import { sk } from './i18n/sk'
import { sv } from './i18n/sv'
import { th } from './i18n/th'
import { tr } from './i18n/tr'
import { uk } from './i18n/uk'
import { vi } from './i18n/vi'
import { zhHans } from './i18n/zh-Hans'
import { zhHant } from './i18n/zh-Hant'
import { zhHantHK } from './i18n/zh-Hant-HK'
import { zhHantTW } from './i18n/zh-Hant-TW'
import { normalizeLocale } from './locales'

export type { Messages } from './i18n/en'
export type { Locale } from '../types'
export { LANGUAGE_NAME, LOCALES, normalizeLocale } from './locales'

export const CATALOG: Readonly<Partial<Record<Locale, Messages>>> = {
  en,
  'zh-Hant-TW': zhHantTW,
  'zh-Hans': zhHans,
  ja,
  ko,
  'zh-Hant': zhHant,
  'zh-Hant-HK': zhHantHK,
  vi,
  uk,
  tr,
  th,
  sv,
  sk,
  ru,
  ro,
  pt,
  'pt-BR': ptBR,
  pl,
  nl,
  nb,
  my,
  ms,
  lo,
  km,
  it,
  id,
  hu,
  hr,
  hi,
  he,
  fr,
  fil,
  fi,
  es,
  'es-MX': esMX,
  el,
  de,
  da,
  cs,
  ca,
  ar,
}

/** A locale's catalog; English for a locale that has none. */
export const messages = (locale: Locale): Messages => CATALOG[locale] ?? en

/** `auto` reads Claude Code's language, then the environment; a pick in settings wins. */
export const resolveLocale = (choice: 'auto' | Locale, claudeLanguage: unknown, envLang = ''): Locale =>
  choice !== 'auto' ? choice : (normalizeLocale(claudeLanguage, envLang) ?? normalizeLocale(envLang) ?? 'en')

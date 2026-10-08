/**
 * Which language the band, the panes, the toasts and the briefs speak. `auto` follows Claude Code's own
 * `language` setting, a free-text value (`正體中文`, `japanese`, `en`), so names and tags both count.
 * Pure: the catalogs are data, `messages(locale)` picks one.
 */
import type { Locale } from '../types'
import { en } from './i18n/en'
import type { Messages } from './i18n/en'
import { ja } from './i18n/ja'
import { ko } from './i18n/ko'
import { zhCN } from './i18n/zh-CN'
import { zhTW } from './i18n/zh-TW'

export type { Messages } from './i18n/en'

export type { Locale } from '../types'
export const LOCALES: readonly Locale[] = ['en', 'zh-TW', 'zh-CN', 'ja', 'ko']

export const CATALOG: Readonly<Record<Locale, Messages>> = { en, 'zh-TW': zhTW, 'zh-CN': zhCN, ja, ko }

export const messages = (locale: Locale): Messages => CATALOG[locale] ?? en

/** Each language as its speakers write it: what a brief asks the model to answer in. */
export const LANGUAGE_NAME: Readonly<Record<Locale, string>> = {
  en: 'English',
  'zh-TW': '臺灣繁體中文',
  'zh-CN': '简体中文',
  ja: '日本語',
  ko: '한국어',
}

const TRADITIONAL = /(zh[-_]?(tw|hk|mo|hant)|traditional|正體|繁體|繁体|臺灣|台灣|台湾|香港|taiwan)/i
const SIMPLIFIED = /(zh[-_]?(cn|sg|hans)|simplified|简体|簡體|简中|大陆|大陸|mainland)/i
const CHINESE = /^(zh|chinese|中文|汉语|漢語|華語|华语)$/i

/**
 * A language setting or a locale tag to one of the five. `chinese` alone leans on the environment
 * (`LANG=zh_TW.UTF-8` reads Traditional); anything unknown is English.
 */
export const normalizeLocale = (value: unknown, envLang = ''): Locale | null => {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!v) return null
  if (TRADITIONAL.test(v)) return 'zh-TW'
  if (SIMPLIFIED.test(v)) return 'zh-CN'
  if (CHINESE.test(v)) return TRADITIONAL.test(envLang) ? 'zh-TW' : 'zh-CN'
  if (/^(ja|jp)([-_.]|$)|japanese|日本語|日本/i.test(v)) return 'ja'
  if (/^ko([-_.]|$)|korean|한국어|한국|韓/i.test(v)) return 'ko'
  if (/^en([-_.]|$)|english|英文|英語|英语/i.test(v)) return 'en'
  return null
}

/** `auto` reads Claude Code's language, then the environment; a pick in settings wins. */
export const resolveLocale = (choice: 'auto' | Locale, claudeLanguage: unknown, envLang = ''): Locale =>
  choice !== 'auto' ? choice : (normalizeLocale(claudeLanguage, envLang) ?? normalizeLocale(envLang) ?? 'en')

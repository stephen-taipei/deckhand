/**
 * The languages Deckhand speaks: one row per locale, its BCP 47 tag, the name its speakers write, and
 * the names people type for it. Pure data and matching: which catalog a locale uses lives in i18n.ts.
 * bin/i18n.py keeps the same list, and tests/test_i18n.py checks the two agree.
 */
import type { Locale } from '../types'

type Row = {
  /** The language as its speakers write it: the settings menu and what a brief asks the model to answer in. */
  name: string
  /** Names people type in Claude Code's `language` setting, compared without case, spaces or punctuation. */
  aliases: readonly string[]
}

export const LOCALE_ROWS: Readonly<Record<Locale, Row>> = {
  en: { name: 'English', aliases: ['english', '英文', '英語', '英语'] },
  'zh-Hant-TW': { name: '臺灣繁體中文', aliases: ['traditionalchinese', 'chinesetraditional', 'chinesetaiwan', 'taiwanese', 'mandarintaiwan', '繁體中文', '繁体中文', '正體中文', '臺灣繁體中文', '台灣繁體中文', '台湾繁体中文', '臺灣華語', '台灣華語'] },
  'zh-Hant': { name: '繁體中文', aliases: [] },
  'zh-Hant-HK': { name: '香港繁體中文', aliases: ['chinesehongkong', 'cantonese', '香港中文', '香港繁體中文', '粵語', '粤语', '廣東話', '广东话'] },
  'zh-Hans': { name: '简体中文', aliases: ['simplifiedchinese', 'chinesesimplified', 'mandarin', '简体中文', '簡體中文', '简中', '普通话'] },
  ja: { name: '日本語', aliases: ['japanese', '日本語', '日语', '日語'] },
  ko: { name: '한국어', aliases: ['korean', '한국어', '한국말', '韓國語', '韩语', '韓語'] },
  vi: { name: 'Tiếng Việt', aliases: ['vietnamese', 'tiengviet', 'tiếngviệt'] },
  uk: { name: 'Українська', aliases: ['ukrainian', 'українська'] },
  tr: { name: 'Türkçe', aliases: ['turkish', 'türkçe', 'turkce'] },
  th: { name: 'ไทย', aliases: ['thai', 'ไทย', 'ภาษาไทย'] },
  sv: { name: 'Svenska', aliases: ['swedish', 'svenska'] },
  sk: { name: 'Slovenčina', aliases: ['slovak', 'slovenčina', 'slovencina'] },
  ru: { name: 'Русский', aliases: ['russian', 'русский'] },
  ro: { name: 'Română', aliases: ['romanian', 'română', 'romana'] },
  pt: { name: 'Português (Portugal)', aliases: ['portuguese', 'português', 'portugues', 'europeanportuguese', 'portugueseportugal'] },
  'pt-BR': { name: 'Português (Brasil)', aliases: ['brazilianportuguese', 'portuguesebrazil', 'portuguêsbrasil', 'portuguesbrasil', 'portuguêsdobrasil'] },
  pl: { name: 'Polski', aliases: ['polish', 'polski'] },
  nl: { name: 'Nederlands', aliases: ['dutch', 'nederlands', 'flemish', 'vlaams'] },
  nb: { name: 'Norsk bokmål', aliases: ['norwegian', 'norwegianbokmål', 'norwegianbokmal', 'norsk', 'norskbokmål', 'bokmål', 'bokmal'] },
  my: { name: 'မြန်မာ', aliases: ['burmese', 'myanmar', 'မြန်မာ', 'မြန်မာဘာသာ'] },
  ms: { name: 'Bahasa Melayu', aliases: ['malay', 'bahasamelayu', 'melayu'] },
  lo: { name: 'ລາວ', aliases: ['lao', 'laotian', 'ລາວ', 'ພາສາລາວ'] },
  km: { name: 'ខ្មែរ', aliases: ['khmer', 'cambodian', 'ខ្មែរ', 'ភាសាខ្មែរ'] },
  it: { name: 'Italiano', aliases: ['italian', 'italiano'] },
  id: { name: 'Bahasa Indonesia', aliases: ['indonesian', 'bahasaindonesia', 'indonesia'] },
  hu: { name: 'Magyar', aliases: ['hungarian', 'magyar'] },
  hr: { name: 'Hrvatski', aliases: ['croatian', 'hrvatski'] },
  hi: { name: 'हिन्दी', aliases: ['hindi', 'हिन्दी', 'हिंदी'] },
  he: { name: 'עברית', aliases: ['hebrew', 'עברית'] },
  fr: { name: 'Français', aliases: ['french', 'français', 'francais'] },
  fil: { name: 'Filipino', aliases: ['filipino', 'tagalog', 'pilipino'] },
  fi: { name: 'Suomi', aliases: ['finnish', 'suomi'] },
  es: { name: 'Español (España)', aliases: ['spanish', 'español', 'espanol', 'castellano', 'spanishspain', 'españolespaña'] },
  'es-MX': { name: 'Español (México)', aliases: ['mexicanspanish', 'spanishmexico', 'latinamericanspanish', 'españolméxico', 'españollatinoamérica', 'espanollatinoamerica'] },
  el: { name: 'Ελληνικά', aliases: ['greek', 'ελληνικά', 'ελληνικα'] },
  de: { name: 'Deutsch', aliases: ['german', 'deutsch'] },
  da: { name: 'Dansk', aliases: ['danish', 'dansk'] },
  cs: { name: 'Čeština', aliases: ['czech', 'čeština', 'cestina'] },
  ca: { name: 'Català', aliases: ['catalan', 'català', 'catala'] },
  ar: { name: 'العربية', aliases: ['arabic', 'العربية', 'عربي'] },
}

/** Every locale, English first: the default and the fallback for a message a catalog lacks. */
export const LOCALES = Object.keys(LOCALE_ROWS) as Locale[]

/** Each language as its speakers write it. */
export const LANGUAGE_NAME = Object.fromEntries(LOCALES.map(l => [l, LOCALE_ROWS[l].name])) as Readonly<Record<Locale, string>>

const squash = (s: string) => s.toLowerCase().replace(/[\s()（）[\]_\-.,/]+/g, '')

const BY_NAME = new Map<string, Locale>()
// The first row that names a spelling keeps it: 繁體中文 reads as Taiwan's, the row before zh-Hant.
for (const l of LOCALES) for (const a of [LOCALE_ROWS[l].name, ...LOCALE_ROWS[l].aliases]) if (!BY_NAME.has(squash(a))) BY_NAME.set(squash(a), l)

const BY_TAG = new Map<string, Locale>(LOCALES.map(l => [l.toLowerCase(), l]))

/** Other spellings of a language subtag: legacy codes and close relatives Deckhand answers in. */
const LANGUAGE_ALIAS: Readonly<Record<string, string>> = { iw: 'he', in: 'id', no: 'nb', nn: 'nb', tl: 'fil', jp: 'ja' }

/** The traditional Chinese a region reads: Hong Kong and Macao read zh-Hant-HK; the rest, Taiwan's. */
const traditional = (rest: readonly string[]): Locale => (rest.some(p => p === 'hk' || p === 'mo') ? 'zh-Hant-HK' : 'zh-Hant-TW')

/** A BCP 47 tag or a POSIX locale (`zh_TW.UTF-8`, `pt-br`, `es-419`) to a locale; null when nothing fits. */
export const localeOfTag = (value: string): Locale | null => {
  const parts = value.split(/[.@]/)[0]!.toLowerCase().split(/[-_]/).filter(Boolean)
  if (!parts.length || !/^[a-z]{2,3}$/.test(parts[0]!)) return null
  const language = LANGUAGE_ALIAS[parts[0]!] ?? parts[0]!
  const rest = parts.slice(1)
  if (language === 'zh') {
    if (rest[0] === 'hant') return rest.length === 1 ? 'zh-Hant' : traditional(rest)
    if (rest.some(p => p === 'tw' || p === 'hk' || p === 'mo')) return traditional(rest)
    return 'zh-Hans'
  }
  if (language === 'pt') return rest.includes('br') ? 'pt-BR' : 'pt'
  // Spanish outside Spain reads Latin American Spanish.
  if (language === 'es') return rest.length && !rest.includes('es') ? 'es-MX' : 'es'
  return BY_TAG.get([language, ...rest].join('-')) ?? BY_TAG.get(language) ?? null
}

const TRADITIONAL_ENV = /zh[-_]?(tw|hk|mo|hant)/i
const CHINESE = /^(zh|chinese|中文|汉语|漢語|華語|华语)$/i

/**
 * Claude Code's `language` setting (free text: `正體中文`, `japanese`, `pt-BR`) or a locale tag to a
 * locale; null when nothing fits. `chinese` alone leans on the environment: `LANG=zh_TW.UTF-8` reads Traditional.
 */
export const normalizeLocale = (value: unknown, envLang = ''): Locale | null => {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!v) return null
  if (CHINESE.test(v)) return TRADITIONAL_ENV.test(envLang) ? (localeOfTag(envLang) ?? 'zh-Hant-TW') : 'zh-Hans'
  const byName = BY_NAME.get(squash(v))
  if (byName) return byName
  const byTag = localeOfTag(v)
  if (byTag) return byTag
  // `Japanese (日本語)`, `中文（台灣）`: try each part on its own.
  for (const part of v.split(/[\s()（）,，/]+/).filter(Boolean)) {
    const hit = BY_NAME.get(squash(part)) ?? (part.length <= 12 ? localeOfTag(part) : null)
    if (hit) return hit
  }
  if (/臺灣|台灣|台湾|taiwan/i.test(v)) return 'zh-Hant-TW'
  if (/香港|hongkong/i.test(squash(v))) return 'zh-Hant-HK'
  return null
}

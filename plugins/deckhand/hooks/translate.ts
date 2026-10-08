/**
 * The `agy_translate` tool: hands translation to agy (Gemini Flash) with the
 * localization standard spelled out, so the main model only reviews.
 */

export type TranslateInput = {
  text: string
  target: string
  source?: string
  context?: string
  glossary?: readonly string[]
}

const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{20,}/,
  /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\b[A-Z][A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD)\s*[=:]\s*['"]?[^\s'"]{8,}/,
]

/** CLAUDE.md: secrets never go into an agy prompt. */
export const findSecret = (text: string) => SECRET.find(pattern => pattern.test(text)) !== undefined

const LOCALE_RULES: Record<string, string> = {
  'zh-tw': [
    '- Write Traditional Chinese as used in Taiwan (臺灣繁體中文), with full-width Chinese punctuation（，。：；「」）.',
    '- Use Taiwan vocabulary, never Mainland terms: 軟體 (not 軟件), 程式 (not 程序), 資料 (not 數據 for "data"), 伺服器 (not 服務器), 預設 (not 默認), 影片 (not 視頻), 網路 (not 網絡), 資訊 (not 信息), 介面 (not 界面), 設定 (not 設置), 品質 (not 質量), 支援 (not 支持 for "support" a feature), 登入 (not 登錄), 帳號 (not 賬號).',
    '- Keep a space between Chinese and Latin words or numbers when it reads naturally in Taiwan tech writing.',
  ].join('\n'),
  'zh-hk': '- Write Traditional Chinese as used in Hong Kong, with Hong Kong vocabulary and punctuation.',
  'zh-cn': '- Write Simplified Chinese as used in Mainland China, with Mainland vocabulary and punctuation.',
  ja: '- Write natural Japanese as used in Japanese software and web products; UI strings in です／ます form unless the source is casual; katakana loanwords only where Japanese products actually use them.',
  ko: '- Write natural Korean as used in Korean software and web products, polite 합니다/해요 style matching the source register.',
}

const rulesFor = (target: string) => {
  const key = target.toLowerCase().replace('_', '-')
  const exact = LOCALE_RULES[key]
  if (exact) return exact
  if (/^zh-(hant|tw)/.test(key) || key === 'zh-hant') return LOCALE_RULES['zh-tw']!
  const base = LOCALE_RULES[key.split('-')[0]!]
  return base ?? `- Follow the wording, spelling and punctuation conventions of the "${target}" locale as its native speakers use them in software and web products.`
}

export const buildPrompt = (input: TranslateInput) =>
  [
    `You are a senior software localizer. Translate the TEXT below${input.source ? ` from ${input.source}` : ''} into the "${input.target}" locale.`,
    '',
    'LOCALIZATION STANDARD (mandatory, overrides literal accuracy):',
    '- Translate meaning, not words: use the expression native speakers of the target locale actually use in software UI, documentation and marketing copy.',
    '- Never keep a literal dictionary sense when the source uses the word idiomatically. Example: English "fresh" meaning new/updated (fresh install, fresh look, fresh data) must become the locale\'s idiomatic word for new/latest (zh-TW: 全新、最新、重新), never the food sense (zh-TW: 新鮮).',
    rulesFor(input.target),
    '- Keep the source tone, register and roughly its length (UI strings stay short).',
    '- Keep unchanged: code, inline code, commands, URLs, file paths, product and brand names, placeholders ({name}, {{var}}, %s, %d, $1, :param), ICU plural/select syntax, HTML/Markdown markup, and the line structure.',
    '- If TEXT is JSON or a JS/TS object, return the same structure and keys, translating only the string values.',
    ...(input.glossary?.length ? ['', 'GLOSSARY (use exactly these renderings):', ...input.glossary.map(g => `- ${g}`)] : []),
    ...(input.context ? ['', `CONTEXT: ${input.context}`] : []),
    '',
    'Output ONLY the translation. No explanations, no notes, no surrounding quotes, no code fences unless TEXT has them.',
    'Do not use any tools or run terminal commands.',
    '',
    'TEXT:',
    '<<<',
    input.text,
    '>>>',
  ].join('\n')

/** agy prints the answer; strip a stray fence or the TEXT delimiters it may echo. */
export const cleanOutput = (stdout: string, source: string) => {
  let out = stdout.trim()
  if (!/^```/.test(source.trim())) out = out.replace(/^```[a-zA-Z-]*\n([\s\S]*?)\n```$/, '$1')
  return out.replace(/^<<<\n?/, '').replace(/\n?>>>$/, '').trim()
}

export const TRANSLATE_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The text, i18n strings (JSON / TS object) or Markdown to translate.' },
    target: { type: 'string', description: 'Target locale, e.g. zh-TW, ja, ko, en, de, fr, es.' },
    source: { type: 'string', description: 'Source locale when it is not obvious.' },
    context: { type: 'string', description: 'Where the text appears (UI button, blog post, landing page) and its audience.' },
    glossary: {
      type: 'array',
      items: { type: 'string' },
      description: 'Fixed renderings, one per entry, e.g. "workflow → 工作流程".',
    },
  },
  required: ['text', 'target'],
} as const

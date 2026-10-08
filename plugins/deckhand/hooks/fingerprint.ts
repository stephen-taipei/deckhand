/**
 * Pure fingerprints for "did it change?": the same for the same content however
 * many times it is fetched, different when the content really changed. The URL
 * watch and the Bash guard's repeated-check counter share them.
 *
 * Masking is deliberately narrow (timestamps, durations, relative times). A
 * counter such as "3 of 5 checks passed" is real progress and must stay visible:
 * a mask that is too wide would stop a watch while the work is still moving.
 */

/** cyrb53, a small synchronous 53-bit string hash. For change detection, not security. */
export const hash = (text: string): string => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

// ── masking what changes on every request ──────────────────────────────────

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')
const SPINNER = /[⠀-⣿]/g

const VOLATILE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<t>'],
  [/\b\d{4}[-/]\d{2}[-/]\d{2}\b/g, '<d>'],
  [/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b/gi, '<c>'],
  [/\b(?:(?:about|less than|over|almost)\s+)?(?:a|an|\d+)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b|\bjust now\b/gi, '<ago>'],
  // 1m23s, 2h 5m, 10 days, 350ms. A digit or letter right after the unit means it is no duration
  // (a commit sha such as 3d9a1f), so the whole run is left alone.
  [/\b(?:\d+(?:\.\d+)?\s*(?:ms|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|[smhd])\s*)+(?![a-z0-9])/gi, '<dur>'],
]

export const maskVolatile = (text: string): string => {
  let out = text.replace(ANSI, '').replace(SPINNER, '')
  for (const [pattern, mask] of VOLATILE) out = out.replace(pattern, mask)
  return out
}

// ── JSON: drop the fields that are about when, not about what ──────────────

const VOLATILE_KEYS = new Set([
  'timestamp', 'time', 'date', 'duration', 'elapsed', 'uptime', 'now', 'ago', 'etag', 'nonce',
  'lastmodified', 'modified', 'requestid', 'request_id', 'traceid', 'trace_id',
])
const VOLATILE_SUFFIX = /(?:[a-z0-9]At|_at|Time|_time|Date|_date|Duration|_duration|Elapsed|_elapsed|Timestamp|_timestamp)$/

export const isVolatileKey = (key: string) => VOLATILE_KEYS.has(key.toLowerCase()) || VOLATILE_SUFFIX.test(key)

/** Keys sorted, volatile keys dropped, arrays order-insensitive: equal for equal meaning. */
export const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalJson).sort((a, b) => {
      const [x, y] = [JSON.stringify(a), JSON.stringify(b)]
      return x < y ? -1 : x > y ? 1 : 0
    })
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isVolatileKey(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => [key, canonicalJson(v)] as const)
    return Object.fromEntries(entries)
  }
  return value
}

/**
 * A signature of command output that ignores noise. JSON compares by meaning; text compares
 * by its set of distinct lines, so a retry loop that appends "Waiting…" again is no progress,
 * while a genuinely new line is.
 */
export const outputSignature = (text: string): string => {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return `json:${hash(JSON.stringify(canonicalJson(JSON.parse(trimmed))))}`
    } catch {
      // Not JSON after all: compare it as text.
    }
  }
  const lines = new Set<string>()
  for (const raw of maskVolatile(text).split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (line) lines.add(line)
  }
  return `text:${hash([...lines].sort().join('\n'))}`
}

// ── HTML: what a deploy changes, not what a request changes ────────────────

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag)
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : undefined
}

const CACHE_BUSTER = /^(?:_|t|ts|v?time|timestamp|nocache|cb|cachebust(?:er)?|rand|random|nonce)$/i

const withoutBusters = (url: string) => {
  const hashAt = url.indexOf('#')
  const bare = hashAt === -1 ? url : url.slice(0, hashAt)
  const q = bare.indexOf('?')
  if (q === -1) return bare
  const kept = bare
    .slice(q + 1)
    .split('&')
    .filter(param => param && !CACHE_BUSTER.test(param.split('=')[0]!))
  return kept.length ? `${bare.slice(0, q)}?${kept.join('&')}` : bare.slice(0, q)
}

/** Script, stylesheet and image URLs: a bundler gives them new hashed names on every build. */
const assetsOf = (html: string) => {
  const urls = new Set<string>()
  for (const m of html.matchAll(/<(?:script|link|img|source|iframe|video|audio)\b[^>]*>/gi)) {
    const url = attr(m[0], 'src') ?? attr(m[0], 'href')
    if (url && !url.startsWith('data:')) urls.add(withoutBusters(url))
  }
  return [...urls].sort()
}

const BUILD_META = /^(?:build|version|commit|release|revision|git|sha|app[-_]?version|generator|deploy)/i

/** `<meta name="build|version|commit|…">`: pages that state their own version. */
const metaOf = (html: string) =>
  [...html.matchAll(/<meta\b[^>]*>/gi)]
    .flatMap(m => {
      const name = attr(m[0], 'name') ?? attr(m[0], 'property')
      const content = attr(m[0], 'content')
      return name && content !== undefined && BUILD_META.test(name) ? [`${name.toLowerCase()}=${content}`] : []
    })
    .sort()

/** Visible text: scripts, styles, comments and attributes (nonces, CSRF tokens) are out. */
const textOf = (html: string) =>
  maskVolatile(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()

/** Names of the parts a fingerprint is made of, by kind. */
export const PART_NAMES: Readonly<Record<string, readonly string[]>> = {
  html: ['assets', 'meta', 'text'],
  json: ['body'],
  text: ['body'],
}

/**
 * `html:<assets>.<meta>.<text>`, `json:<body>` or `text:<body>`. Each part is its own hash,
 * so a page that keeps changing can be told which part keeps changing.
 */
export const fingerprintBody = (contentType: string | undefined, body: string): string => {
  const head = body.trimStart().slice(0, 64).toLowerCase()
  const isHtml = (contentType ?? '').toLowerCase().includes('html') || /^<(?:!doctype html|html|head|body)/.test(head)
  if (isHtml) {
    return `html:${[assetsOf(body).join('\n'), metaOf(body).join('\n'), textOf(body)].map(hash).join('.')}`
  }
  return outputSignature(body)
}

/** A header by name, whatever case the host spelled it in. */
export const headerOf = (headers: Readonly<Record<string, string>>, name: string): string | undefined => {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value
  return undefined
}

const partsOf = (signature: string) => {
  const fp = signature.slice(signature.indexOf('|') + 1)
  const colon = fp.indexOf(':')
  return { kind: fp.slice(0, colon), hashes: fp.slice(colon + 1).split('.') }
}

/** Which parts of a series of `<status>|<fingerprint>` signatures differ between neighbours. */
export const changingParts = (signatures: readonly string[]): string[] => {
  const names = new Set<string>()
  for (let i = 1; i < signatures.length; i += 1) {
    const before = partsOf(signatures[i - 1]!)
    const after = partsOf(signatures[i]!)
    if (before.kind !== after.kind) {
      names.add('type')
      continue
    }
    after.hashes.forEach((h, k) => {
      if (h !== before.hashes[k]) names.add(PART_NAMES[after.kind]?.[k] ?? 'body')
    })
  }
  return [...names]
}

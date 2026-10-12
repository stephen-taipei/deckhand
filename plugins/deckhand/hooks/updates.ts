/**
 * The update check: at most once a day, the newest GitHub Release against the installed version, and one
 * toast per newer version. Pure: the URL, the version compare and what the store keeps, so tests can read it.
 */

export const RELEASES_URL = 'https://api.github.com/repos/stephen-taipei/deckhand/releases/latest'
export const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000

/** What `$.store` keeps under `updateCheck`: when GitHub was last asked, and the version last announced. */
export type UpdateState = { checkedAt: number; notified: string }

const VERSION = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/

export const parseVersion = (v: string): [number, number, number] | null => {
  const m = v.trim().match(VERSION)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True when `latest` is a later x.y.z than `current`; false when either is not a version. */
export const isNewer = (latest: string, current: string): boolean => {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return false
}

/** The version a `releases/latest` answer names (`v1.2.1` → `1.2.1`), or null for a draft, a pre-release or anything else. */
export const latestVersion = (body: string): string | null => {
  try {
    const r = JSON.parse(body) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
    if (r.draft === true || r.prerelease === true || typeof r.tag_name !== 'string') return null
    const v = parseVersion(r.tag_name)
    return v ? v.join('.') : null
  } catch {
    return null
  }
}

export const readUpdateState = (raw: unknown): UpdateState => {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    checkedAt: typeof o.checkedAt === 'number' && Number.isFinite(o.checkedAt) ? o.checkedAt : 0,
    notified: typeof o.notified === 'string' ? o.notified : '',
  }
}

/** Never checked, a day since the last look, or a clock that went backwards: due. */
export const isCheckDue = (s: UpdateState, now: number) => s.checkedAt === 0 || now - s.checkedAt >= UPDATE_CHECK_MS || now < s.checkedAt

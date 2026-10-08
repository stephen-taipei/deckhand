export type WatchKind = 'pr' | 'run' | 'url'

export type WatchStatus = 'watching' | 'done' | 'stopped'

/** One deploy / PR / CI / site watch, polled locally without model tokens. */
export type Watch = {
  id: string
  kind: WatchKind
  /** PR number, Actions run id, or URL. */
  target: string
  /** owner/repo for `gh --repo`; absent means the session's repo. */
  repo?: string
  /** For a URL watch: text whose appearance means the new version is live. */
  expect?: string
  cwd: string
  label: string
  /** Latest human-readable state. */
  summary: string
  /** What "no change" is measured against. */
  signature: string
  /** Rechecks that found the same signature as the check before (0 right after a change). */
  unchanged: number
  /** When the signature last changed; a watch stops only after it has stood still long enough. */
  changedAt?: number
  /** The signatures of the last checks, newest last: tells a page that flaps from one that deployed. */
  seen?: string[]
  /** URL watch without `expect`: the first healthy signature; a different one, seen twice, means a deploy. */
  baseline?: string
  checks: number
  intervalMs: number
  nextAt: number
  status: WatchStatus
  reason?: string
  startedBy: 'user' | 'model'
}

/** A user-facing Codex thread, read from ~/.codex. */
export type CodexThread = {
  id: string
  name: string
  cwd: string
  updatedAt: number
  lastUser: string
  lastAssistant: string
}

/** A rate-limit window as the engine reports it for the last API response. */
export type EngineLimit = { kind: string; percent: number; resetsAt?: string }

/** One window of the account's usage (what the app's usage card shows). */
export type AccountWindow = { key: string; label: string; percent: number; resetsAt?: string }

export type AccountLimits = {
  windows: AccountWindow[]
  fetchedAt: number
  /** `ok`, or why the account's usage could not be read. */
  status: string
  raw?: string
}

declare module 'claude-code' {
  interface PluginState {
    'deckhand': {
      watches: Watch[]
      isBandHidden: boolean
      codexThreads: CodexThread[]
      codexError: string | null
      isCodexLoading: boolean
      codexAllProjects: boolean
      engineLimits: EngineLimit[]
      accountLimits: AccountLimits | null
      contextPercent: number | null
      contextTokens: number | null
      /** The main loop's model, as `/model` shows it: which button is lit. */
      model: string
      /** The effort of the last finished turn: what a model switch keeps. */
      effort: string | null
    }
  }
}

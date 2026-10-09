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

export type Locale = 'en' | 'zh-TW' | 'zh-CN' | 'ja' | 'ko'

export type DelegateTool = 'codex' | 'agent' | 'agy'

/** One delegate button: which CLI, which model, at which effort. */
export type DelegateTarget = {
  /** The button's label, 1 to 6 letters or digits, case kept (`cL`). */
  key: string
  enabled: boolean
  tool: DelegateTool
  /** The model id as the CLI takes it (`gpt-6-luna`, `grok-4.7-high`). */
  model: string
  effort: string
  /** The model as people say it, for the tooltip and the brief. */
  name: string
}

/** A tool that hands one kind of work to a delegate: off until the person turns it on. */
export type Assist = { enabled: boolean; slot: number }

/** Which part of the ⚙ pane shows, which delegate is open for editing, whether reset waits for a confirm. */
export type SettingsView = { tab: 'general' | 'delegates' | 'assist' | 'sub5' | 'advanced'; editing: number; isResetArmed: boolean }

/** The person's settings, edited in the ⚙ pane and kept in `$.store`. */
export type DeckhandSettings = {
  version: 3
  /** `auto` follows Claude Code's own `language` setting. */
  language: 'auto' | Locale
  show: { usage: boolean; models: boolean; sub5: boolean; delegates: boolean; recap: boolean }
  delegates: DelegateTarget[]
  sub5: { max: number; model: string; effort: string }
  /** Empty means: find it (PATH, then the usual install places). */
  paths: { codexHome: string; codexBin: string; agentBin: string; agyBin: string }
  guards: { attribution: boolean; polling: boolean; repeatLimit: number }
  watch: { pollSeconds: number; stallMinutes: number }
  usage: { warnPercent: number }
  /** The translate tool: on or off, and the delegate slot (0 to 4) it hands the text to. */
  translate: Assist
  /** The search tool: on or off, and the delegate slot (0 to 4) that searches the web. */
  search: Assist
}

/** What the recap pane shows. */
export type RecapState = { status: 'idle' | 'working' | 'done' | 'error'; text: string; at: number }

export type DelegateRunStatus = 'running' | 'answered' | 'failed' | 'stopped' | 'lost'

/** A `delegate.py run` Bash call, as the band shows it while it runs and for a while after. */
export type DelegateRun = {
  /** The Bash call's id. */
  id: string
  label: string
  tool?: DelegateTool
  name?: string
  startedAt: number
  /** delegate.py's --timeout (its default when absent): a run with no word long past it is lost. */
  timeoutMin: number
  status: DelegateRunStatus
  /** delegate.py's exit code: 0 answered, 2 refused, 3 CLI not found, 4 timed out, 5 failed. */
  exitCode?: number
  /** How long the delegated model took, as delegate.py said. */
  seconds?: number
  finishedAt?: number
  answerPath?: string
  /** The background task the call became: its notification ends the run. */
  taskId?: string
  /** The run folder, once `delegate.py list` matched it. */
  folder?: string
}

/** One run folder, as `delegate.py list` reports it; null where its meta.json does not say. */
export type DelegateRecord = {
  id: string
  path: string
  label: string
  /** Epoch seconds. */
  started: number | null
  tool: DelegateTool | null
  model: string | null
  name: string | null
  seconds: number | null
  exit: number | null
  answerPath: string | null
  answerBytes: number | null
  hasStderr: boolean
  firstLine: string
}

/** The answer the records pane has open. */
export type DelegateAnswer = { path: string; label: string; who: string; text: string }

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
      /** The person's settings; null until the session has loaded them. */
      settings: DeckhandSettings | null
      /** The language the band, the panes and the briefs speak. */
      locale: Locale
      /** The recap pane's content. */
      recap: RecapState
      settingsView: SettingsView
      /** Where each delegate CLI was found: a path, null when missing, absent while unchecked. */
      bins: Partial<Record<DelegateTool, string | null>>
      /** Model families whose weekly window the account has shown: they read – while unreadable. */
      knownScoped: string[]
      /** Delegate runs in flight and just finished: the band's progress rows. Never the brief. */
      delegateRuns: DelegateRun[]
      /** Written every second while a run is in flight: what makes its elapsed time tick. */
      delegateTick: number
      /** The records pane: the run folders of the last 3 days, and the answer it has open. */
      delegateRecords: DelegateRecord[]
      delegateRecordsError: string | null
      isDelegateRecordsLoading: boolean
      delegateAnswer: DelegateAnswer | null
    }
  }
}

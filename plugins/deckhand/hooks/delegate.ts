/**
 * The delegate buttons: which outside model each one stands for (the person's settings), the exact
 * command line that runs it, and the brief the main agent gets (one per language, in the catalogs).
 * The exact parts (CLI flags, read-only mode, the secrets check, the time limit, the record) are
 * bin/delegate.py's; the judgment (what to hand over, whether the answer holds) is the main agent's.
 * Kept free of `$` so tests can read it.
 */
import type { Locale, Messages } from './i18n'
import type { DelegateTarget, DelegateTool } from './settings'
import { shq } from './shell'

export const TOOL_NAME: Readonly<Record<DelegateTool, string>> = { codex: 'Codex', agent: 'Cursor agent', agy: 'agy' }

/** `Codex (GPT-6 Luna, effort max)`, in the catalog's punctuation. */
export const targetLabel = (t: DelegateTarget, m: Messages) => m.delegate.label(TOOL_NAME[t.tool], t.name, t.effort)

/** The enabled target on this label, whatever its case. */
export const findTarget = (targets: readonly DelegateTarget[], key: string) =>
  targets.find(t => t.enabled && t.key.toLowerCase() === key.trim().toLowerCase())

export type CommandArgs = {
  /** Absolute path of bin/delegate.py. */
  tool: string
  target: DelegateTarget
  locale: Locale
  /** The CLI's path when the person set one; empty finds it. */
  bin?: string
  /** CODEX_HOME for a codex target, when the person set one. */
  codexHome?: string
}

/** `run` and the target's flags, unquoted. */
const runArgs = (o: CommandArgs) => [
  'run',
  '--tool',
  o.target.tool,
  '--model',
  o.target.model,
  '--effort',
  o.target.effort,
  '--label',
  o.target.key,
  '--name',
  o.target.name,
  '--lang',
  o.locale,
  ...(o.bin ? ['--bin', o.bin] : []),
  ...(o.codexHome && o.target.tool === 'codex' ? ['--codex-home', o.codexHome] : []),
]

/** The command line the brief hands the main agent, up to the heredoc opener. */
export const delegateCommand = (o: CommandArgs) => ['python3', o.tool, ...runArgs(o)].map(shq).join(' ')

/** Minutes a translation or a web search may take before delegate.py stops the CLI. */
export const TRANSLATE_MINUTES = 5
export const SEARCH_MINUTES = 8

/**
 * The process of the translate and search tools: the prompt is whole (`--raw`: no standard rules in
 * front of it) and stdout is the answer alone; `web` lets the CLI search the web (Codex needs it
 * switched on). `python` is the interpreter's resolved path.
 */
export const assistArgv = (o: CommandArgs & { python: string; minutes: number; web?: boolean }) => [
  o.python,
  o.tool,
  ...runArgs(o),
  '--raw',
  ...(o.web ? ['--web'] : []),
  '--timeout',
  String(o.minutes),
]

export type BriefArgs = CommandArgs & { task: string; attribution: boolean }

export const delegatePrompt = (o: BriefArgs, m: Messages): string =>
  m.delegate.brief({
    key: o.target.key,
    label: targetLabel(o.target, m),
    task: o.task.trim(),
    command: delegateCommand(o),
    toolName: TOOL_NAME[o.target.tool],
    readsFiles: o.target.tool !== 'agy',
    languageName: m.languageName,
    attribution: o.attribution,
  })

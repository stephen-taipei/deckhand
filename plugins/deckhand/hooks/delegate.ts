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
  targets.find(t => t.enabled && t.key === key.trim().toUpperCase())

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

/** The command line the brief hands the main agent, up to the heredoc opener. */
export const delegateCommand = (o: CommandArgs) =>
  [
    'python3',
    shq(o.tool),
    'run',
    '--tool',
    o.target.tool,
    '--model',
    shq(o.target.model),
    '--effort',
    o.target.effort,
    '--label',
    o.target.key,
    '--name',
    shq(o.target.name),
    '--lang',
    o.locale,
    ...(o.bin ? ['--bin', shq(o.bin)] : []),
    ...(o.codexHome && o.target.tool === 'codex' ? ['--codex-home', shq(o.codexHome)] : []),
  ].join(' ')

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

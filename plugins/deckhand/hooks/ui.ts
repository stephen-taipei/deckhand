/**
 * The plugin's visual vocabulary, in one place: every surface draws state with these, never with a
 * colour name or an emoji of its own. Tones are theme keys, so they follow the person's light or dark
 * theme the way Claude Code's own UI does. Marks are single-width, so a terminal never misaligns them.
 */
import type { ThemeKey } from 'claude-code'

/** What a colour means. One meaning per tone: success is never "will be removed", warning is never "stopped". */
export const TONE = {
  ok: 'success',
  bad: 'error',
  warn: 'warning',
  muted: 'subtle',
  accent: 'suggestion',
} as const satisfies Record<string, ThemeKey>

export type Tone = keyof typeof TONE

/** One mark per state, the same in the band, the panes and the toasts. */
export const MARK = {
  running: '◐',
  done: '✓',
  failed: '✕',
  stopped: '■',
  warn: '!',
} as const

export type Mark = keyof typeof MARK

/** How long a toast stays: long enough to read, never so long it outstays its news. */
export const TOAST = {
  /** Something worked as expected ("Saved", "Copied"). */
  done: 3_000,
  /** News worth a read: a watch finished, a delegate was sent. */
  info: 6_000,
  /** Something failed or needs a look. */
  problem: 10_000,
  /** The person has to act: run a command, press Enter. */
  action: 20_000,
} as const

/** A label and a tone for a watch's state. */
export const watchState = (status: 'watching' | 'done' | 'stopped'): { mark: string; tone: Tone | undefined } =>
  status === 'watching' ? { mark: MARK.running, tone: undefined } : status === 'done' ? { mark: MARK.done, tone: 'ok' } : { mark: MARK.stopped, tone: 'muted' }

/** A label and a tone for a delegate run's state. */
export const runState = (status: string): { mark: string; tone: Tone | undefined } =>
  status === 'running'
    ? { mark: MARK.running, tone: undefined }
    : status === 'answered'
      ? { mark: MARK.done, tone: 'ok' }
      : status === 'failed'
        ? { mark: MARK.failed, tone: 'bad' }
        : status === 'stopped'
          ? { mark: MARK.stopped, tone: 'muted' }
          : { mark: MARK.warn, tone: 'warn' }

/** The tone of a usage gauge: quiet while fine, warning near the limit, error at it. */
export const usageTone = (level: 'ok' | 'warn' | 'high' | 'unknown'): Tone => (level === 'high' ? 'bad' : level === 'warn' ? 'warn' : 'muted')

/** What a value with nothing in it reads as, everywhere. */
export const EMPTY = '—'

/** A pane narrower than this stacks a label above its field. */
export const NARROW_COLUMNS = 60

/** How many list entries fit, given the rows the pane has and the rows one entry takes. */
export const listRoom = (rows: number | undefined, headerRows: number, rowsPerEntry: number) =>
  Math.max(1, Math.floor(((rows ?? 30) - headerRows) / rowsPerEntry))

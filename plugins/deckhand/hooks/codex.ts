/**
 * Pure helpers for the Claude ↔ Codex handoff and the Codex inbox. The handoff
 * file itself (folder, file name, git facts, secret masking, comparison with the
 * repo) is made by bin/handoff-state.py, which Codex runs too; this file only
 * words the narrative request and reads the tool's answers.
 */
import type { CodexThread } from '../types'

/** What the model is asked for: the narrative only. Git facts are the tool's, filled from real git. */
export const HANDOFF_PROMPT = (note: string) =>
  [
    '請根據到目前為止的完整對話，寫一份交給 Codex 接手的交接文件內文。',
    '用臺灣繁體中文，Markdown 格式，只輸出內文，不要前言、結語，也不要 front matter。',
    '檔案開頭的 branch、HEAD、PR 編號、未提交檔案數由程式用 git 填入：不要重複，也不要憑記憶寫。',
    '必須包含以下段落，沒有內容的段落寫「無」：',
    '## 目標：使用者最終要達成什麼。',
    '## 目前狀態：只寫程式查不到的事實：部署與 CI 結果、外部系統狀態、卡住的原因。',
    '## 已完成：逐項列出，附檔案路徑或 commit。',
    '## 未完成與下一步：編號步驟，每步一個動作，條件寫在動作前。',
    '## 使用者已確認的決定與限制：照使用者原話的意思列出，不要自行擴充。',
    '## 風險與注意事項：尚未驗證的推測要標明「未驗證」。',
    '## 驗證方式：Codex 完成後要執行的指令或檢查。',
    '規則：指令、路徑、URL、識別字照原樣引用。secret、token、密碼、私鑰或個資一律寫成 `<REDACTED>`。',
    ...(note ? [`使用者補充：${note}`] : []),
  ].join('\n')

/** Models like to wrap a whole document in a ```markdown fence; the file should hold the document. */
export const unfence = (text: string) => {
  const m = text.trim().match(/^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/i)
  return (m ? m[1]! : text).trim()
}

// ── answers of bin/handoff-state.py ────────────────────────────────────────

export type HandoffWritten = {
  path: string
  latest: string
  project: string
  /** Secrets the tool masked in the narrative. */
  redacted: number
  state: Record<string, string | number>
  nextPrompt: string
}

export type HandoffChecked = {
  path: string
  age: string
  differences: number
  report: string
  nextPrompt: string
}

/** `check` found no usable file: `missing`, or `no-front-matter` (a file this tool did not write). */
export type HandoffMissing = { error: string; path: string }

const objectOf = (stdout: string): Record<string, unknown> | null => {
  const lines = stdout.trim().split('\n')
  for (const candidate of [stdout.trim(), lines[lines.length - 1] ?? '']) {
    try {
      const value: unknown = JSON.parse(candidate)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      // Try the last line, then give up.
    }
  }
  return null
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

export const parseWritten = (stdout: string): HandoffWritten | null => {
  const o = objectOf(stdout)
  if (!o || !text(o.path) || !text(o.next_prompt)) return null
  const state = typeof o.state === 'object' && o.state !== null ? (o.state as Record<string, string | number>) : {}
  return {
    path: text(o.path),
    latest: text(o.latest),
    project: text(o.project),
    redacted: typeof o.redacted === 'number' ? o.redacted : 0,
    state,
    nextPrompt: text(o.next_prompt),
  }
}

export const parseChecked = (stdout: string): HandoffChecked | HandoffMissing | null => {
  const o = objectOf(stdout)
  if (!o) return null
  if (text(o.error)) return { error: text(o.error), path: text(o.path) }
  if (!text(o.path) || !text(o.next_prompt)) return null
  return {
    path: text(o.path),
    age: text(o.age),
    differences: typeof o.differences === 'number' ? o.differences : 0,
    report: text(o.report),
    nextPrompt: text(o.next_prompt),
  }
}

/** One line of what the tool recorded: `專案 x · main @ abc1234 · 未提交 2 · PR #7 OPEN`. */
export const stateLine = (state: Record<string, string | number>) => {
  const parts = [`專案 ${state.project ?? '?'}`]
  if (state.branch) parts.push(`${state.branch}${state.head ? ` @ ${String(state.head).slice(0, 7)}` : ''}`)
  if (state.dirty_files !== undefined) parts.push(`未提交 ${state.dirty_files}${state.untracked_files ? `＋未追蹤 ${state.untracked_files}` : ''}`)
  if (state.pr_number) parts.push(`PR #${state.pr_number}${state.pr_state ? ` ${state.pr_state}` : ''}`)
  return parts.join(' · ')
}

// ── Codex inbox ────────────────────────────────────────────────────────────

export const pastePrompt = (t: CodexThread) =>
  `以下是 Codex thread「${t.name}」的最新回覆（${t.cwd}）。請先核對內容與 repo 現況，再接手：\n\n<codex_reply>\n${t.lastAssistant}\n</codex_reply>\n`

export const ago = (ms: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000))
  if (minutes < 60) return `${minutes} 分鐘前`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} 小時前` : `${Math.round(hours / 24)} 天前`
}

export const threadsArgv = (pluginRoot: string, root: string, isAll: boolean) => [
  'python3',
  `${pluginRoot}/bin/codex-threads.py`,
  '--days',
  '7',
  '--limit',
  '12',
  ...(isAll ? [] : ['--cwd', root]),
]

/** The About tab of the settings pane: the plugin's and Claude Code's versions, a release check on demand, and diagnostics to copy. */
import { atom, read, update } from 'claude-code'

import type { AboutView, DelegateTool } from '../types'
import { msgs } from './core'
import type { Engine } from './core'
import { TOOL_NAME } from './delegate'
import { foundBins } from './session'
import { TOAST } from './ui'
import { isNewer, latestVersion, parseVersion, RELEASES_URL } from './updates'

/** The first Claude Code that loads a hooks module split across files. */
export const MIN_CLAUDE_CODE = '2.1.299'

export const REPO_URL = 'https://github.com/stephen-taipei/deckhand'

/** docs/images/logo.svg: the `>_` prompt with the cursor in Claude's coral. */
export const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<rect x="4" y="4" width="504" height="504" rx="108" fill="#0F172A" stroke="#334155" stroke-width="8"/>' +
  '<polyline points="140,168 236,256 140,344" fill="none" stroke="#F8FAFC" stroke-width="48" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<rect x="276" y="320" width="120" height="44" rx="22" fill="#D97757"/>' +
  '</svg>'

const aboutAtom = atom({ plugin: 'deckhand', key: 'about' } as const, { version: '', engine: '', latest: '', check: 'idle' } as AboutView)

/** Whether Claude Code is older than the plugin needs; false when its version cannot be read. */
export const isEngineTooOld = (engine: string) => {
  const v = parseVersion(engine.split('-')[0] ?? '')
  return v !== null && isNewer(MIN_CLAUDE_CODE, v.join('.'))
}

export async function aboutState($: Engine) {
  return read($, aboutAtom)
}

/** Reads both versions when the tab opens. Nothing goes over the network here. */
export async function loadAbout($: Engine) {
  const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => '{}')) as { version?: unknown }
  const version = typeof manifest.version === 'string' ? manifest.version : ''
  const engine = (await $.session.version().catch(() => ({ version: '' }))).version
  await update($, aboutAtom, a => ({ ...a, version, engine }))
}

/** Check now: asks GitHub for the newest release, the same question the daily check asks. */
export async function checkLatest($: Engine) {
  await update($, aboutAtom, (a): AboutView => ({ ...a, check: 'checking' }))
  const res = await $.http.fetch(RELEASES_URL, { headers: { accept: 'application/vnd.github+json' } }).catch(() => null)
  const latest = res?.ok ? latestVersion(res.text) : null
  await update($, aboutAtom, (a): AboutView => (latest ? { ...a, latest, check: 'done' } : { ...a, check: 'failed' }))
}

/** What an issue needs, in English whatever the display language: versions, the surface and which CLIs are found (never their paths). */
export async function copyDiagnostics($: Engine, surface: Parameters<Engine['ui']['copy']>[0]['surface']) {
  const a = await read($, aboutAtom)
  const found = await foundBins($)
  const clis = (Object.keys(TOOL_NAME) as DelegateTool[]).map(t => `${TOOL_NAME[t]}: ${found[t] ? 'found' : found[t] === null ? 'not found' : 'not checked'}`)
  const text = [`Deckhand ${a.version || '?'}`, `Claude Code ${a.engine || '?'} (${surface})`, ...clis].join('\n')
  const m = await msgs($)
  const copied = await $.ui.copy({ text, surface }).catch(() => ({ isCopied: false }))
  $.ui.toast(copied.isCopied ? m.settings.about.copied : m.settings.about.copyFailed, { timeoutMs: TOAST.done })
}

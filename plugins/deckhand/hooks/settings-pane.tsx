/** The settings pane (⚙ and /deckhand): its tabs, saving a field, the settings file, and redoing what depends on a setting once it changes. */
import { ASSISTS, assistTarget, checkBins, foundBins, registerAssist, registerCommands, registerWorker } from './session'
import type { Assist } from './session'
import { CODEX_PANE } from './handoff'
import { DELEGATES_PANE } from './delegates'
import { changedFields, defaultSettings, DELEGATE_EFFORTS, DELEGATE_TOOLS, expandHome, fieldOf, normalizeSettings, SETTINGS_FILE, settingsFileText, SUB5_EFFORTS, SUB5_MODELS, withField } from './settings'
import { cellWidth, EMPTY, NARROW_COLUMNS, TOAST, TONE } from './ui'
import type { Engine } from './core'
import { LANGUAGE_NAME, LOCALES } from './i18n'
import type { Messages } from './i18n'
import type { On, RenderElement } from 'claude-code'
import { RECAP_PANE } from './recap'
import { leftoversState, loadLeftovers, openLeftovers, SUB5_CLEAN_PANE } from './leftovers'
import type { Settings } from './settings'
import type { SettingsFileView, SettingsView } from '../types'
import { targetLabel, TOOL_NAME } from './delegate'
import { asRecord, cfg, cfgForDrawing, currentLocale, msgs, msgsForDrawing, storeSettings } from './core'
import { atom, read, update } from 'claude-code'
import { errorText } from './state'

/**
 * Each open pane of the plugin in the current language. A pane keeps the title it was opened with, and the
 * app does not always draw an open pane again when the language changes: the settings pane, where the
 * language is picked, is closed and opened again (its tab is kept); the others are retitled in place.
 */
export async function retitlePanes($: Engine, m: Messages) {
  const titles: Record<string, string> = {
    [SETTINGS_PANE]: m.settings.title,
    [DELEGATES_PANE]: m.delegate.recordsTitle,
    [RECAP_PANE]: m.recap.paneTitle,
    [SUB5_CLEAN_PANE]: m.sub5.cleanTitle,
    [CODEX_PANE]: m.codex.paneTitle,
  }
  for (const pane of await $.ui.panes().catch(() => [])) {
    const title = titles[pane.id]
    if (!title) continue
    if (pane.id === SETTINGS_PANE) await $.ui.close({ id: SETTINGS_PANE }).catch(() => undefined)
    await $.ui.open({ id: pane.id, title, ...(pane.id === SETTINGS_PANE ? { focus: true } : {}) }).catch(() => undefined)
  }
}

/** Saves settings, then redoes what depends on them: the language, the commands, the worker, the CLIs. */
export async function commitSettings($: Engine, next: Settings) {
  const before = await cfg($)
  const localeBefore = await currentLocale($)
  const claude = asRecord(await $.settings.read().catch(() => ({})))
  await storeSettings($, next, claude.language)
  const m = await msgs($)
  if ((await currentLocale($)) !== localeBefore) await retitlePanes($, m)
  if (before.language !== next.language) await registerCommands($, m, next).catch(error => $.ui.log(`deckhand: commands not registered (${errorText(error)})`))
  if (before.language !== next.language || JSON.stringify(before.sub5) !== JSON.stringify(next.sub5) || before.guards.attribution !== next.guards.attribution) {
    await registerWorker($, m, next)
  }
  if (JSON.stringify(before.paths) !== JSON.stringify(next.paths) || JSON.stringify(before.delegates) !== JSON.stringify(next.delegates)) {
    void checkBins($).catch(() => undefined)
  }
  for (const kind of ASSISTS) {
    if (next[kind].enabled && !before[kind].enabled) {
      await registerAssist($, next, kind).catch(error => $.ui.log(`deckhand: ${kind} tool not registered (${errorText(error)})`))
    }
  }
}

/** One edit from the ⚙ pane: kept when it survives the checks, else the old value stays and the person is told. */
export async function saveField($: Engine, field: string, value: unknown, label: string) {
  const m = await msgs($)
  const s = await cfg($)
  const next = normalizeSettings(withField(s, field, value), s, LOCALES)
  const before = fieldOf(s, field)
  const after = fieldOf(next, field)
  const isRefused = String(after) === String(before) && String(value).trim().toLowerCase() !== String(before).toLowerCase()
  if (isRefused) {
    $.ui.toast(m.settings.invalid(label), { timeoutMs: TOAST.problem })
    return
  }
  await commitSettings($, next)
  // Read the catalog again: the edit may have been the language itself.
  $.ui.toast((await msgs($)).settings.saved, { timeoutMs: TOAST.done })
}

/** Whether the settings pane is up: ⚙ is drawn pressed while it is. */
export async function isSettingsShown($: Engine) {
  return read($, settingsOpenAtom)
}

export async function markSettingsOpen($: Engine, isOpen: boolean) {
  await update($, settingsOpenAtom, () => isOpen)
}

export async function openSettings($: Engine) {
  const m = await msgs($)
  await $.ui.open({ id: SETTINGS_PANE, title: m.settings.title, focus: true })
  await update($, settingsOpenAtom, () => true)
  if ((await read($, settingsViewAtom)).tab === 'sub5') void loadLeftovers($).catch(() => undefined)
}

/** ⚙: closes the settings pane when it is the one shown, opens (or brings it forward) otherwise. */
export async function toggleSettings($: Engine) {
  const pane = (await $.ui.panes().catch(() => [])).find(p => p.id === SETTINGS_PANE)
  if (pane?.isShown) {
    await closeSettings($)
    return
  }
  await openSettings($)
}

/** The plugin's own close does not pass through its own ui.close hook: the state is cleared here. */
export async function closeSettings($: Engine) {
  await $.ui.close({ id: SETTINGS_PANE })
  await update($, settingsOpenAtom, () => false)
}

export async function setFile($: Engine, patch: Partial<SettingsFileView>) {
  await update($, settingsFileAtom, v => ({ ...v, ...patch }))
}

/** The typed path as shown and with `~` expanded; null (and a toast) when there is none to use. */
export async function settingsFilePath($: Engine, m: Messages): Promise<{ shown: string; full: string } | null> {
  const shown = (await read($, settingsFileAtom)).path.trim()
  const home = shown.startsWith('~') ? ((await $.env.get('HOME').catch(() => undefined)) ?? '') : ''
  if (!shown || /[\n\r\0]/.test(shown) || (shown.startsWith('~') && !home)) {
    $.ui.toast(m.settings.fileNoPath, { timeoutMs: TOAST.problem })
    return null
  }
  return { shown, full: expandHome(shown, home) }
}

/** Writes the settings to the typed path; a file already there is replaced only on the second press. */
export async function exportSettings($: Engine, isConfirmed: boolean) {
  const m = await msgs($)
  const where = await settingsFilePath($, m)
  if (!where) return
  try {
    if (!isConfirmed && (await $.fs.exists(where.full))) {
      await setFile($, { ...DISARMED, armed: 'export' })
      return
    }
    await $.fs.write(where.full, settingsFileText(await cfg($)))
    await setFile($, DISARMED)
    $.ui.toast(m.settings.exported(where.shown), { timeoutMs: TOAST.done })
  } catch (error) {
    $.ui.toast(m.settings.exportFailed(errorText(error)), { timeoutMs: TOAST.problem })
  }
}

/**
 * Reads a settings file and checks it against the current settings, field by field, as the store is
 * read; what would change waits for the Apply press. A missing or unreadable file changes nothing.
 */
export async function readImport($: Engine) {
  const m = await msgs($)
  const where = await settingsFilePath($, m)
  if (!where) return
  await setFile($, DISARMED)
  let text: string
  try {
    if (!(await $.fs.exists(where.full))) {
      $.ui.toast(m.settings.importMissing(where.shown), { timeoutMs: TOAST.problem })
      return
    }
    text = await $.fs.read(where.full)
  } catch (error) {
    $.ui.toast(m.settings.importFailed(errorText(error)), { timeoutMs: TOAST.problem })
    return
  }
  const raw = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return null
    }
  })()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    $.ui.toast(m.settings.importInvalid(where.shown), { timeoutMs: TOAST.problem })
    return
  }
  const s = await cfg($)
  const next = normalizeSettings(raw, s, LOCALES)
  const changes = changedFields(s, next).length
  if (!changes) {
    $.ui.toast(m.settings.importSame, { timeoutMs: TOAST.info })
    return
  }
  await setFile($, { armed: 'import', pending: next, changes })
}

export async function applyImport($: Engine) {
  const file = await read($, settingsFileAtom)
  if (!file.pending) return
  await commitSettings($, file.pending)
  await setFile($, DISARMED)
  // Read the catalog again: the import may have changed the language.
  $.ui.toast((await msgs($)).settings.imported(file.changes), { timeoutMs: TOAST.done })
}

export async function copySettings($: Engine, surface: Parameters<Engine['ui']['copy']>[0]['surface']) {
  const m = await msgs($)
  const copied = await $.ui.copy({ text: settingsFileText(await cfg($)), surface }).catch(() => ({ isCopied: false }))
  $.ui.toast(copied.isCopied ? m.settings.copied : m.settings.copyFailed, { timeoutMs: TOAST.done })
}

export const SETTINGS_PANE = 'deckhand-settings'

/** Whether the settings pane is open: ⚙ is a toggle, drawn pressed while it is. */
const settingsOpenAtom = atom({ plugin: 'deckhand', key: 'isSettingsOpen' } as const, false)

const settingsViewAtom = atom({ plugin: 'deckhand', key: 'settingsView' } as const, { tab: 'general', editing: -1, isResetArmed: false } as SettingsView)

const settingsFileAtom = atom({ plugin: 'deckhand', key: 'settingsFile' } as const, {
  path: SETTINGS_FILE,
  armed: null,
  pending: null,
  changes: 0,
} as SettingsFileView)

const DISARMED: Partial<SettingsFileView> = { armed: null, pending: null, changes: 0 }

/** The hooks of this part of the plugin; register.tsx calls this first. */
export function registerSettingsPane(on: On) {
  // ── Settings pane ───────────────────────────────────────────────────────

  // Closed by its ✕ or by the engine: ⚙ stops being drawn pressed.
  on('ui.close', { id: SETTINGS_PANE }, async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      await update($, settingsOpenAtom, () => false)
    }
  })

  on('command.run', { command: 'deckhand' }, async $ => {
    await openSettings($)
    return { text: (await msgs($)).settings.title }
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // The mobile app draws no field: there the pane shows the values instead of fields.
    const Input = 'Input' in ui ? ui.Input : undefined
    const Select = 'Select' in ui ? ui.Select : undefined
    const m = await msgsForDrawing($)
    const s = await cfgForDrawing($)
    const found = await foundBins($)
    const view = await read($, settingsViewAtom)
    const file = await read($, settingsFileAtom)
    const leftovers = await leftoversState($)
    // A label beside its field reads fastest; a narrow pane stacks them.
    const isNarrow = e.props.bodyColumns < NARROW_COLUMNS
    const setView = (patch: (v: SettingsView) => Partial<SettingsView>) =>
      void update($, settingsViewAtom, v => ({ ...v, ...patch(v) })).catch(() => undefined)
    const save = (field: string, value: unknown, label: string) => void saveField($, field, value, label).catch(() => undefined)

    const check = (field: string, value: boolean, label: string) => (
      <Button key={`t-${field}`} label={`${value ? '☑' : '☐'} ${label}`} variant="secondary" onPress={() => save(field, !value, label)} />
    )
    // The labels of the shown tab: the label column is as wide as its longest one (a CJK character takes two cells).
    const tabLabels: Record<SettingsView['tab'], string[]> = {
      general: [m.settings.language, m.settings.warnPercent],
      delegates: [m.settings.label, m.settings.tool, m.settings.modelId, m.settings.effort, m.settings.name],
      assist: [],
      sub5: [m.settings.model, m.settings.effort, m.settings.max],
      advanced: [m.settings.codexHome, TOOL_NAME.codex, TOOL_NAME.agent, TOOL_NAME.agy, m.settings.repeatLimit, m.settings.pollSeconds, m.settings.stallMinutes, m.settings.filePath],
    }
    const labelWidth = Math.min(30, Math.max(8, ...tabLabels[view.tab].map(cellWidth)))
    const row = (key: string, label: string, control: RenderElement) => (
      <Box key={`r-${key}`} flexDirection={isNarrow ? 'column' : 'row'} columnGap={2} alignItems={isNarrow ? 'flex-start' : 'center'}>
        <Box width={isNarrow ? undefined : labelWidth} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        {control}
      </Box>
    )
    const field = (key: string, label: string, value: string | number, asNumber = false) =>
      row(
        key,
        label,
        Input ? (
          <Input key={`i-${key}`} value={String(value)} submitLabel={m.settings.save} onSubmit={(v: string) => save(key, asNumber ? Number(v) : v, label)} />
        ) : (
          <Text key={`i-${key}`}>{String(value) || EMPTY}</Text>
        ),
      )
    const choice = (key: string, label: string, value: string, options: readonly { value: string; label: string }[]) =>
      row(
        key,
        label,
        Select ? (
          <Select key={`s-${key}`} value={value} options={options} onSelect={(v: string) => save(key, v, label)} />
        ) : (
          <Text key={`s-${key}`}>{options.find(o => o.value === value)?.label ?? value}</Text>
        ),
      )
    const plain = (list: readonly string[]) => list.map(v => ({ value: v, label: v }))
    const heading = (key: string, title: string, hint?: string, isFirst = false) => (
      <Box key={`h-${key}`} flexDirection="column" marginTop={isFirst ? 0 : 1}>
        <Text bold>{title}</Text>
        {hint ? <Text dimColor>{hint}</Text> : null}
      </Box>
    )

    const TABS = ['general', 'delegates', 'assist', 'sub5', 'advanced'] as const
    const tabs = (
      <Box key="tabs" gap={1} flexWrap="wrap">
        {TABS.map(t => (
          <Button
            key={`tab-${t}`}
            label={m.settings.tabs[t]}
            variant={view.tab === t ? 'primary' : 'secondary'}
            onPress={() => {
              setView(() => ({ tab: t, editing: -1, isResetArmed: false }))
              void setFile($, DISARMED).catch(() => undefined)
              if (t === 'sub5') void loadLeftovers($).catch(() => undefined)
            }}
          />
        ))}
      </Box>
    )

    const general = (
      <Box key="general" flexDirection="column" gap={1}>
        {heading('display', m.settings.display, undefined, true)}
        {choice('language', m.settings.language, s.language, [
          { value: 'auto', label: m.settings.auto },
          ...LOCALES.map(l => ({ value: l, label: LANGUAGE_NAME[l] })),
        ])}
        {heading('buttons', m.settings.buttons, m.settings.buttonsHint)}
        <Box gap={1} flexWrap="wrap">
          {check('show.usage', s.show.usage, m.settings.showUsage)}
          {check('show.models', s.show.models, m.settings.showModels)}
          {s.show.models && check('show.modelsOnDesktop', s.show.modelsOnDesktop, m.settings.showModelsOnDesktop)}
          {check('show.sub5', s.show.sub5, m.settings.showSub5)}
          {check('show.delegates', s.show.delegates, m.settings.showDelegates)}
          {check('show.recap', s.show.recap, m.settings.showRecap)}
        </Box>
        {field('usage.warnPercent', m.settings.warnPercent, s.usage.warnPercent, true)}
      </Box>
    )

    // One line per delegate; Edit opens its fields below it, one delegate at a time.
    const delegates = (
      <Box key="delegates" flexDirection="column" gap={1}>
        {heading('delegates', m.settings.delegates, m.settings.delegatesHint, true)}
        {s.delegates.map((t, i) => (
          <Box key={`d-${i}`} flexDirection="column" gap={1}>
            {/* The controls come first: the summary after them is what gives way when the pane is narrow. */}
            <Box gap={1} alignItems="center">
              {check(`delegates.${i}.enabled`, t.enabled, t.key)}
              <Button
                key={`edit-${i}`}
                label={view.editing === i ? m.settings.done : m.settings.edit}
                variant={view.editing === i ? 'primary' : 'secondary'}
                onPress={() => setView(v => ({ editing: v.editing === i ? -1 : i }))}
              />
              {found[t.tool] === null ? <Text color={TONE.warn}>{m.settings.cliMissing}</Text> : null}
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text dimColor={!t.enabled} wrap="truncate">{`${TOOL_NAME[t.tool]} · ${t.name} · ${t.effort}`}</Text>
              </Box>
            </Box>
            {view.editing === i ? (
              <Box flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
                {field(`delegates.${i}.key`, m.settings.label, t.key)}
                {choice(`delegates.${i}.tool`, m.settings.tool, t.tool, DELEGATE_TOOLS.map(v => ({ value: v, label: TOOL_NAME[v] })))}
                {field(`delegates.${i}.model`, m.settings.modelId, t.model)}
                {choice(`delegates.${i}.effort`, m.settings.effort, t.effort, plain(DELEGATE_EFFORTS))}
                {field(`delegates.${i}.name`, m.settings.name, t.name)}
              </Box>
            ) : null}
          </Box>
        ))}
      </Box>
    )

    // Translate and search: a switch, then one press picks the delegate.
    const assistPart = (kind: Assist, title: string, hint: string) => {
      const a = s[kind]
      const t = assistTarget(s, kind)
      return (
        <Box key={`a-${kind}`} flexDirection="column" gap={1}>
          <Box gap={1} alignItems="center">
            {check(`${kind}.enabled`, a.enabled, title)}
          </Box>
          <Text dimColor>{a.enabled ? hint : `${hint}${m.settings.assistOff}`}</Text>
          {a.enabled ? (
            <Box gap={1} alignItems="center" flexWrap="wrap">
              <Text>{m.settings.assistBy}</Text>
              {s.delegates.map((d, i) => (
                <Button
                  key={`${kind === 'translate' ? 'tr' : 'se'}-${i}`}
                  label={d.key}
                  variant={i === a.slot ? 'primary' : 'secondary'}
                  onPress={() => save(`${kind}.slot`, i, title)}
                />
              ))}
            </Box>
          ) : null}
          {a.enabled ? (
            <Box gap={1}>
              <Text dimColor>{`→ ${targetLabel(t, m)} · ${t.model}`}</Text>
              {found[t.tool] === null ? <Text color={TONE.warn}>{m.settings.cliMissing}</Text> : null}
            </Box>
          ) : null}
        </Box>
      )
    }
    const assist = (
      <Box key="assist" flexDirection="column" gap={1}>
        {heading('assist', m.settings.tabs.assist, m.settings.assistNote, true)}
        {assistPart('translate', m.settings.translate, m.settings.translateHint)}
        {assistPart('search', m.settings.search, m.settings.searchHint)}
      </Box>
    )

    const sub5 = (
      <Box key="sub5" flexDirection="column" gap={1}>
        {heading('sub5', m.settings.sub5, m.settings.sub5Hint, true)}
        {choice('sub5.model', m.settings.model, s.sub5.model, plain(SUB5_MODELS))}
        {choice('sub5.effort', m.settings.effort, s.sub5.effort, plain(SUB5_EFFORTS))}
        {field('sub5.max', m.settings.max, s.sub5.max, true)}
        <Box key="leftovers" gap={1} alignItems="center">
          <Text dimColor>{m.settings.leftovers(leftovers.status === 'done' ? leftovers.entries.length : null)}</Text>
          <Button key="sub5-leftovers" label={m.settings.leftoversOpen} variant="secondary" onPress={() => void openLeftovers($).catch(() => undefined)} />
        </Box>
      </Box>
    )

    const advanced = (
      <Box key="advanced" flexDirection="column" gap={1}>
        {heading('paths', m.settings.paths, m.settings.pathsHint, true)}
        {field('paths.codexHome', m.settings.codexHome, s.paths.codexHome)}
        {field('paths.codexBin', TOOL_NAME.codex, s.paths.codexBin)}
        {field('paths.agentBin', TOOL_NAME.agent, s.paths.agentBin)}
        {field('paths.agyBin', TOOL_NAME.agy, s.paths.agyBin)}
        {heading('guards', m.settings.guards)}
        <Box gap={1} flexWrap="wrap">
          {check('guards.attribution', s.guards.attribution, m.settings.attribution)}
          {check('guards.polling', s.guards.polling, m.settings.polling)}
        </Box>
        {field('guards.repeatLimit', m.settings.repeatLimit, s.guards.repeatLimit, true)}
        {heading('updates', m.settings.updates, m.settings.updatesHint)}
        <Box gap={1} flexWrap="wrap">
          {check('updates.check', s.updates.check, m.settings.updateCheck)}
        </Box>
        {heading('watch', m.settings.watch)}
        {field('watch.pollSeconds', m.settings.pollSeconds, s.watch.pollSeconds, true)}
        {field('watch.stallMinutes', m.settings.stallMinutes, s.watch.stallMinutes, true)}
        {heading('file', m.settings.file, m.settings.fileHint)}
        {row(
          'settingsFile',
          m.settings.filePath,
          Input ? (
            <Input
              key="i-settingsFile"
              value={file.path}
              submitLabel={m.settings.fileUse}
              onInput={(v: string) => void setFile($, { ...DISARMED, path: v }).catch(() => undefined)}
              onSubmit={(v: string) => void setFile($, { ...DISARMED, path: v }).catch(() => undefined)}
            />
          ) : (
            <Text key="i-settingsFile">{file.path}</Text>
          ),
        )}
        <Box gap={1} flexWrap="wrap">
          <Button key="file-export" label={m.settings.fileExport} variant="secondary" onPress={() => void exportSettings($, false).catch(() => undefined)} />
          <Button key="file-import" label={m.settings.fileImport} variant="secondary" onPress={() => void readImport($).catch(() => undefined)} />
          <Button key="file-copy" label={m.settings.fileCopy} variant="secondary" onPress={press => void copySettings($, press.surface).catch(() => undefined)} />
        </Box>
        {file.armed !== null ? (
          <Box gap={1} alignItems="center" flexWrap="wrap">
            <Text color={TONE.warn}>{file.armed === 'export' ? m.settings.fileExists(file.path) : m.settings.importChanges(file.changes)}</Text>
            {file.armed === 'export' ? (
              <Button key="file-overwrite" label={m.settings.fileOverwrite} variant="primary" onPress={() => void exportSettings($, true).catch(() => undefined)} />
            ) : (
              <Button key="file-apply" label={m.settings.importApply} variant="primary" onPress={() => void applyImport($).catch(() => undefined)} />
            )}
            <Button key="file-cancel" label={m.settings.fileCancel} variant="secondary" onPress={() => void setFile($, DISARMED).catch(() => undefined)} />
          </Box>
        ) : null}
        {heading('reset', m.settings.reset, m.settings.resetHint)}
        {view.isResetArmed ? (
          <Box gap={1} alignItems="center" flexWrap="wrap">
            <Text color={TONE.bad}>{m.settings.resetSure}</Text>
            <Button
              key="reset-confirm"
              label={m.settings.resetConfirm}
              variant="primary"
              onPress={async () => {
                const claude = asRecord(await $.settings.read().catch(() => ({})))
                await commitSettings($, defaultSettings({ attributionOff: asRecord(claude.attribution).commit === '' }))
                setView(() => ({ isResetArmed: false }))
                $.ui.toast((await msgs($)).settings.resetDone, { timeoutMs: TOAST.done })
              }}
            />
            <Button key="reset-cancel" label={m.settings.resetCancel} variant="secondary" onPress={() => setView(() => ({ isResetArmed: false }))} />
          </Box>
        ) : (
          <Box>
            <Button key="reset" label={m.settings.reset} variant="secondary" onPress={() => setView(() => ({ isResetArmed: true }))} />
          </Box>
        )}
      </Box>
    )

    const body = { general, delegates, assist, sub5, advanced }[view.tab]
    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {body}
        {e.surface !== 'desktop' && (
          <Box>
            <Button key="close" label={m.settings.close} role="dismiss" onPress={() => void closeSettings($)} />
          </Box>
        )}
      </Box>
    )
  })
}

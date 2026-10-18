/** The band above the prompt: the running watches and delegate runs, then the control row (usage, model buttons, Sub5, the delegates, Recap, a tip slot and ⚙). */
import type { On } from 'claude-code'

import { startDelegate, startSub5 } from './actions'
import { cfgForDrawing, msgsForDrawing } from './core'
import { targetLabel } from './delegate'
import { bandRuns, clearFinishedRows, isFinished, openRecords } from './delegates'
import { currentModel, currentSegments, pressModel } from './models'
import { galaxyState, startGalaxy } from './galaxy'
import { startRecap } from './recap'
import { runLine, whoOf } from './runs'
import { foundBins } from './session'
import { isSettingsShown, toggleSettings } from './settings-pane'
import { MARK, runState, TONE, usageTone, watchState } from './ui'
import { MODEL_BUTTONS, modelFamily } from './usage'
import { bandWatches, hideWatches, isBandHidden, stopWatches } from './watches'


/** The hooks of this part of the plugin; register.tsx calls this first. */
export function registerBand(on: On) {
  // The band above the prompt: the running watches, then the control row: the usage readout, the model
  // buttons, Sub5, the delegates, the recap, a tip slot that takes the free width, and ⚙ at the right end.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await msgsForDrawing($)
    const s = await cfgForDrawing($)
    const watches = await bandWatches($)
    const hasWatches = watches.length > 0 && !(await isBandHidden($))
    const hasFinished = watches.some(w => w.status !== 'watching')
    // Delegate runs: read the tick so the elapsed time is drawn again every second.
    const runs = s.show.delegates ? await bandRuns($) : []
    const now = runs.length ? await $.clock.now() : 0
    const segments = s.show.usage ? await currentSegments($, s.usage.warnPercent, true) : []
    const family = modelFamily(await currentModel($))
    const found = await foundBins($)
    const galaxy = await galaxyState($)
    const showGalaxy = s.show.galaxy && galaxy.open !== ''
    const isWorking = e.props.isWorking
    const isSettingsOpen = await isSettingsShown($)
    const isDesktop = e.surface === 'desktop'
    // In the desktop app its own model menu switches in a click; the buttons only fill `/model <id>` there.
    const showModels = s.show.models && (!isDesktop || s.show.modelsOnDesktop)
    // A target whose CLI is known to be missing has no button; an unchecked one keeps it.
    const targets = s.show.delegates ? s.delegates.filter(t => t.enabled && found[t.tool] !== null) : []
    const scope = (id: string) => `deckhand-tip-${id}`
    const tips = [
      ...(segments.length ? [{ id: 'usage', text: m.tips.usage }] : []),
      ...(showModels ? MODEL_BUTTONS.map(b => ({ id: `m-${b.key}`, text: isDesktop ? m.tips.modelDesktop(b.name) : m.tips.model(b.name) })) : []),
      ...(s.show.sub5 ? [{ id: 'sub5', text: m.tips.sub5(s.sub5.max) }] : []),
      ...targets.map(t => ({ id: `d-${t.key}`, text: m.tips.delegate(targetLabel(t, m)) })),
      ...(s.show.recap ? [{ id: 'recap', text: m.tips.recap }] : []),
      ...(showGalaxy ? [{ id: 'galaxy', text: m.tips.galaxy }] : []),
      { id: 'gear', text: m.tips.settings },
      ...runs.filter(isFinished).map(r => ({ id: `dr-${r.id}`, text: m.delegate.recordsTip })),
    ]
    // Clear and Hide end the last watch or delegate row instead of taking a line of their own.
    const shownWatches = hasWatches ? watches.slice(-4) : []
    const lastRow = runs.length ? `r-${runs[runs.length - 1]!.id}` : shownWatches.length ? `w-${shownWatches[shownWatches.length - 1]!.id}` : ''
    const rowActions = [
      ...((hasWatches && hasFinished) || runs.some(isFinished)
        ? [<Button key="clear" label={m.watch.clearDone} variant="secondary" onPress={() => void clearFinishedRows($)} />]
        : []),
      ...(hasWatches ? [<Button key="hide" label={m.watch.hide} variant="secondary" onPress={() => void hideWatches($)} />] : []),
    ]
    return (
      <Box flexDirection="column">
        {galaxy.isOpen && (
          <Box key="galaxy-open" gap={1}>
            <Text color={TONE.accent}>{`${MARK.running} ${m.galaxy.label}`}</Text>
            <Text dimColor wrap="truncate">
              {m.galaxy.waiting}
            </Text>
          </Box>
        )}
        {shownWatches.map(w => {
          const state = watchState(w.status)
          return (
          <Box key={`w-${w.id}`} gap={1}>
            <Text color={state.tone && TONE[state.tone]}>
              {state.mark} {w.label}
            </Text>
            <Text dimColor wrap="truncate">
              {w.reason ?? w.summary}
              {w.status === 'watching' ? m.watch.checkCount(w.checks) : ''}
            </Text>
            {w.status === 'watching' && <Button key={`stop-${w.id}`} label={m.watch.stop} variant="secondary" onPress={() => void stopWatches($, w.id)} />}
            {lastRow === `w-${w.id}` && rowActions}
          </Box>
          )
        })}
        {runs.map(r => {
          const line = runLine(r, now, m)
          const state = runState(r.status)
          return (
            <Box key={`r-${r.id}`} gap={1}>
              <Text color={state.tone && TONE[state.tone]}>
                {line.mark} {r.label}
              </Text>
              <Text dimColor wrap="truncate">
                {line.text}
              </Text>
              {isFinished(r) && (
                <Button
                  key={`dr-${r.id}`}
                  label={m.delegate.records}
                  variant="secondary"
                  hover={{ scope: scope(`dr-${r.id}`) }}
                  onPress={() =>
                    void openRecords($, r.answerPath && r.status === 'answered' ? { path: r.answerPath, label: r.label, who: whoOf(r.tool, r.name, m) } : undefined)
                  }
                />
              )}
              {lastRow === `r-${r.id}` && rowActions}
            </Box>
          )
        })}
        <Box gap={1} flexWrap="wrap">
          {/* The gauges, a quiet dot between them; only a gauge near its limit takes a colour. */}
          {segments.flatMap((seg, i) => [
            ...(i > 0 ? [<Text key={`u-sep-${seg.id}`} dimColor hover={{ scope: scope('usage') }}>·</Text>] : []),
            <Text
              key={`u-${seg.id}`}
              color={seg.level === 'high' || seg.level === 'warn' ? TONE[usageTone(seg.level)] : undefined}
              dimColor={seg.level === 'ok' || seg.level === 'unknown'}
              hover={{ scope: scope('usage') }}
            >
              {seg.text}
            </Text>,
          ])}
          {showModels &&
            MODEL_BUTTONS.map(b => (
              <Button
                key={`m-${b.key}`}
                label={b.key}
                variant={family === b.family ? 'primary' : 'secondary'}
                dimColor={family !== b.family}
                hover={{ scope: scope(`m-${b.key}`) }}
                onPress={press => void pressModel($, b.family, isWorking, press.surface)}
              />
            ))}
          {s.show.sub5 && (
            <Button key="sub5" label="Sub5" variant="secondary" hover={{ scope: scope('sub5') }} onPress={() => void startSub5($, '', isWorking)} />
          )}
          {targets.map(t => (
            <Button
              key={`d-${t.key}`}
              label={t.key}
              variant="secondary"
              hover={{ scope: scope(`d-${t.key}`) }}
              onPress={() => void startDelegate($, t, '', isWorking, true)}
            />
          ))}
          {s.show.recap && (
            <Button key="recap" label={m.recap.label} variant="secondary" hover={{ scope: scope('recap') }} onPress={() => void startRecap($)} />
          )}
          {showGalaxy && (
            <Button key="galaxy" label={m.galaxy.label} variant="secondary" hover={{ scope: scope('galaxy') }} onPress={() => void startGalaxy($, isWorking)} />
          )}
          <Box key="tips" flexGrow={1} minWidth={1}>
            {tips.map(t => (
              <Box
                key={`tip-${t.id}`}
                position="absolute"
                top={0}
                left={0}
                width="100%"
                display="none"
                hover={{ display: 'flex', scope: scope(t.id) }}
              >
                <Text key={`tip-text-${t.id}`} dimColor wrap="truncate">
                  {t.text}
                </Text>
              </Box>
            ))}
          </Box>
          <Button key="gear" label="⚙" variant={isSettingsOpen ? 'primary' : 'secondary'} hover={{ scope: scope('gear') }} onPress={() => void toggleSettings($)} />
        </Box>
      </Box>
    )
  })
}

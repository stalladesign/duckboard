import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, CompactState, GitFact, Pending, Row } from '../types'
import { detailItems, drawDetails, drawFooter, drawGroup, drawRow, drawRule, drawTop, GROUP_LABEL, metaParts, PALETTE, textBar } from './draw'
import { fmtDur, resetsIn } from './format'
import { canCompact, compactNote, failed, formatLine, newId, onReply, parseLine, request, showButton, tick, unwrap, type Line } from './compact'
import { gitFact, log, readTheme, scan } from './scan'

const PANE = 'duckboard'
const SCAN_MS = 20_000
const GIT_TTL_MS = 60_000
// shortcut: remote surfaces report the pane in code-font cells, not pixels. 7.8 px (a 13 px monospace
// advance) was measured on the desktop app: 147 columns drew a 1,160 px pane. Upgrade if the engine reports pixels.
const PX_PER_COLUMN = 7.8
const BUTTONS_PX = 96

const boardA = atom({ plugin: 'duckboard', key: 'board' } as const, null as Board | null)
const coldOpenA = atom({ plugin: 'duckboard', key: 'coldOpen' } as const, false)
const openRowsA = atom({ plugin: 'duckboard', key: 'openRows' } as const, [] as string[])
const themeA = atom({ plugin: 'duckboard', key: 'theme' } as const, 'light' as 'light' | 'dark')
const compactA = atom({ plugin: 'duckboard', key: 'compact' } as const, {} as Record<string, CompactState>)
const gitA = atom({ plugin: 'duckboard', key: 'git' } as const, {} as Record<string, GitFact>)
const pendingA = atom({ plugin: 'duckboard', key: 'pending' } as const, null as Pending | null)
const turnA = atom({ plugin: 'duckboard', key: 'isTurnRunning' } as const, false)

// Module state: a hot reload starts these over; the next scan fills them again.
const commits: Record<string, string | null> = {}
const autoTried = new Set<string>()
let isScanning = false
let isRunningPending = false

type Auto = { isOn: boolean; idleMin: number; minTokens: number }

async function refreshGit($: EngineInterface, row: Row, force: boolean) {
  if (!row.cwd) return
  const now = await $.clock.now()
  const had = (await read($, gitA))[row.sessionId]
  if (!force && had && now - had.at < GIT_TTL_MS) return
  const { fact, commit } = await gitFact($, row.cwd, now)
  commits[row.sessionId] = commit
  await update($, gitA, g => ({ ...g, [row.sessionId]: fact }))
}

async function runScan($: EngineInterface, addressName: string, auto: Auto) {
  if (isScanning) return
  isScanning = true
  try {
    const board = await scan($, { addressName, commits })
    await update($, boardA, () => board)
    const theme = await readTheme($)
    if (theme !== (await read($, themeA))) await update($, themeA, () => theme)
    const open = new Set(await read($, openRowsA))
    for (const r of board.rows) if (open.has(r.sessionId) && r.group !== 'cold') await refreshGit($, r, false)
    await autoCompact($, board, auto)
  } catch (err) {
    log($, 'scan', err)
    const at = await $.clock.now()
    const msg = err instanceof Error ? err.message : String(err)
    await update($, boardA, b => (b ? { ...b, error: msg } : { scannedAt: at, rows: [], headless6h: 0, limits: [], limitsReadAt: null, error: msg }))
  } finally {
    isScanning = false
  }
}

async function setCompact($: EngineInterface, sid: string, next: CompactState | null) {
  await update($, compactA, m => {
    const out = { ...m }
    if (next) out[sid] = next
    else delete out[sid]
    return out
  })
}

async function sendLine($: EngineInterface, sessionId: string, line: Line) {
  const r = await $.session.send({ to: { sessionId }, text: formatLine(line) })
  if (!r.isDelivered) log($, `send ${line.kind} to ${sessionId}`, r.reason)
}

// Compact a row: this session through the engine, another one by a request line it answers.
async function pressCompact($: EngineInterface, row: Row, surface: string) {
  const now = await $.clock.now()
  const id = newId(crypto.getRandomValues(new Uint8Array(6)))
  const prev = (await read($, compactA))[row.sessionId] ?? null
  const sent = request(prev, id, now)
  await setCompact($, row.sessionId, sent)
  if (row.isThis) return compactSelf($, row.sessionId, sent, id, surface)
  try {
    const me = await $.session.id()
    const r = await $.session.send({ to: { sessionId: row.sessionId }, text: formatLine({ kind: 'request', id, from: me }) })
    // auto mode can answer "no verdict" and block the send: show the engine's own words
    if (!r.isDelivered) await setCompact($, row.sessionId, failed(sent, r.reason, await $.clock.now()))
  } catch (err) {
    log($, 'send compact request', err)
    await setCompact($, row.sessionId, failed(sent, err instanceof Error ? err.message : String(err), await $.clock.now()))
  }
}

async function compactSelf($: EngineInterface, sid: string, sent: CompactState, id: string, surface: string) {
  const at = await $.clock.now()
  await setCompact($, sid, onReply(sent, { kind: 'started', id }, at))
  await update($, pendingA, () => ({ id, from: null, at }))
  const fail = async (reason: string) => {
    await update($, pendingA, () => null)
    await setCompact($, sid, failed((await read($, compactA))[sid] ?? sent, reason, await $.clock.now()))
  }
  try {
    const r = await $.session.compact()
    if (r.skip !== undefined) return fail(r.skip)
    await finishPending($, id, { kind: 'result', id, ok: true, before: r.tokensBefore ?? null, after: r.tokensAfter ?? null })
  } catch (err) {
    log($, 'compact this session', err)
    const msg = err instanceof Error ? err.message : String(err)
    // On the terminal the engine's refusal is the answer; queueing a /compact would hide it.
    if (surface === 'terminal') return fail(msg)
    try {
      // Headless (the desktop app): $.session.compact is refused, the /compact command is not.
      await $.command.run({ command: 'compact', args: '' })
      if ((await read($, pendingA))?.id === id) await fail(`/compact ran but no compaction followed (${msg})`)
    } catch (err2) {
      log($, 'run /compact', err2)
      await fail(err2 instanceof Error ? err2.message : String(err2))
    }
  }
}

// Report the open request once: to the peer that asked, or to this session's own row.
async function finishPending($: EngineInterface, id: string, line: Line) {
  const p = await read($, pendingA)
  if (!p || p.id !== id) return
  await update($, pendingA, () => null)
  if (p.from !== null) return sendLine($, p.from, line)
  const me = await $.session.id()
  await setCompact($, me, onReply((await read($, compactA))[me] ?? null, line, await $.clock.now()))
}

// The receiver's side: compact now, or when the running turn ends.
async function runPending($: EngineInterface) {
  const p = await read($, pendingA)
  if (!p || p.from === null || isRunningPending || (await read($, turnA))) return
  isRunningPending = true
  try {
    const r = await $.session.compact()
    if (r.skip !== undefined) await finishPending($, p.id, { kind: 'result', id: p.id, ok: false, reason: r.skip })
    else await finishPending($, p.id, { kind: 'result', id: p.id, ok: true, before: r.tokensBefore ?? null, after: r.tokensAfter ?? null })
  } catch (err) {
    log($, 'compact on request', err)
    try {
      await $.command.run({ command: 'compact', args: '' })
      const msg = err instanceof Error ? err.message : String(err)
      await finishPending($, p.id, { kind: 'result', id: p.id, ok: false, reason: `/compact ran but no compaction followed (${msg})` })
    } catch (err2) {
      log($, 'run /compact on request', err2)
      await finishPending($, p.id, { kind: 'result', id: p.id, ok: false, reason: err2 instanceof Error ? err2.message : String(err2) })
    }
  } finally {
    isRunningPending = false
  }
}

async function takeRequest($: EngineInterface, l: Extract<Line, { kind: 'request' }>) {
  const at = await $.clock.now()
  await update($, pendingA, () => ({ id: l.id, from: l.from, at }))
  const busy = await read($, turnA)
  await sendLine($, l.from, { kind: busy ? 'queued' : 'started', id: l.id })
  if (!busy) $.clock.after(0, () => void runPending($).catch(err => log($, 'compact on request', err)))
}

async function takeReply($: EngineInterface, l: Line) {
  const now = await $.clock.now()
  const all = await read($, compactA)
  const sid = Object.keys(all).find(k => all[k]!.ids.includes(l.id))
  if (!sid) return log($, 'compact reply', `no open request has id ${l.id}`)
  await setCompact($, sid, onReply(all[sid]!, l, now))
}

async function tickCompact($: EngineInterface) {
  const now = await $.clock.now()
  const all = await read($, compactA)
  for (const [sid, s] of Object.entries(all)) {
    const t = tick(s, now)
    if (t !== s) await setCompact($, sid, t)
  }
}

async function autoCompact($: EngineInterface, board: Board, auto: Auto) {
  // Under the 60 minute cache lifetime only: past it there is no warm cache to keep.
  if (!auto.isOn || auto.idleMin >= 60) return
  const all = await read($, compactA)
  for (const row of board.rows) {
    const key = `${row.sessionId}:${row.lastReplyAt}`
    if (!canCompact(row) || all[row.sessionId] || autoTried.has(key)) continue
    if (row.idleSince === null || board.scannedAt - row.idleSince < auto.idleMin * 60_000) continue
    if ((row.tokens ?? 0) < auto.minTokens) continue
    autoTried.add(key)
    await pressCompact($, row, 'auto')
  }
}

export const register: Register = (on, options) => {
  const addressName = String(options.addressName ?? '')
  const auto: Auto = {
    isOn: options.autoCompact === true,
    idleMin: Number(options.autoCompactIdleMinutes ?? 50),
    minTokens: Number(options.autoCompactMinTokens ?? 100_000),
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'duckboard', description: 'Open the duckboard pane: every Claude Code session on this computer' })
    $.clock.every(SCAN_MS, () => void runScan($, addressName, auto).catch(err => log($, 'timer scan', err)))
    // Redraws "Updated Ns ago" between scans.
    $.clock.every(5000, () => {
      $.ui.invalidate('ui.render')
      void tickCompact($).catch(err => log($, 'compact timers', err))
    })
    void runScan($, addressName, auto).catch(err => log($, 'first scan', err))
    void $.ui.open({ id: PANE, title: 'duckboard' }).then(
      r => { if (!r.isPlaced) log($, 'pane not placed at start', r.reason) },
      err => log($, 'open pane at start', err),
    )
    return started
  })

  on('command.run', { command: 'duckboard' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'duckboard' })
    void runScan($, addressName, auto).catch(err => log($, 'command scan', err))
    return { text: opened.isPlaced ? 'duckboard opened.' : `duckboard is not placed: ${opened.reason}` }
  })

  on('session.receive', async ($, e, next) => {
    // Only a peer session's message, and only an exact protocol line; all else goes on.
    if (e.origin.kind !== 'peer' || 'teammate' in e.origin || e.agentId !== undefined) return next(e)
    const l = parseLine(unwrap(e.text))
    if (!l) return next(e)
    if (l.kind === 'request') await takeRequest($, l)
    else await takeReply($, l)
    return { consumed: `duckboard compact-${l.kind}` }
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    const p = await read($, pendingA)
    if (p) {
      const line: Line = r.skip !== undefined ? { kind: 'result', id: p.id, ok: false, reason: r.skip } : { kind: 'result', id: p.id, ok: true, before: r.tokensBefore ?? null, after: r.tokensAfter ?? null }
      await finishPending($, p.id, line)
    }
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, turnA, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      await update($, turnA, () => false)
      // A request queued mid-turn runs once the turn is over.
      $.clock.after(0, () => void runPending($).catch(err => log($, 'compact after turn', err)))
    }
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const board = await read($, boardA)
    const coldOpen = await read($, coldOpenA)
    const openRows = await read($, openRowsA)
    const git = await read($, gitA)
    const compact = await read($, compactA)
    const theme = await read($, themeA)
    const now = await $.clock.now()
    if (!board) return <Text dimColor>Reading sessions.</Text>

    const groups = (['working', 'yourturn', 'cold'] as const).map(g => ({ g, rows: board.rows.filter(r => r.group === g) }))
    const counts = {
      working: groups[0]!.rows.length,
      yourturn: groups[1]!.rows.length,
      agents: board.rows.reduce((n, r) => n + r.agentsRunning, 0),
    }
    const toggleCold = () => update($, coldOpenA, v => !v)
    const toggleRow = async (row: Row) => {
      const isOpen = (await read($, openRowsA)).includes(row.sessionId)
      await update($, openRowsA, list => (isOpen ? list.filter(x => x !== row.sessionId) : [...list, row.sessionId]))
      if (!isOpen) await refreshGit($, row, true)
    }
    const ago = now - board.scannedAt
    const noteFor = (row: Row) => compactNote(compact[row.sessionId] ?? null, row, now)
    const compactBtn = (row: Row) => {
      const label = showButton(row, compact[row.sessionId] ?? null)
      return label && <Button key={`c-${row.sessionId}`} onPress={() => pressCompact($, row, e.surface)}>{label}</Button>
    }

    // The terminal's table carries an Svg that draws nothing: pick by surface, not by the table.
    if (e.surface !== 'terminal' && 'Svg' in els && els.Svg) {
      const Svg = els.Svg
      const W = Math.max(260, Math.round(e.props.bodyColumns * PX_PER_COLUMN))
      const RW = W - BUTTONS_PX
      const hover = { backgroundColor: PALETTE[theme].hover }
      const top = drawTop({ limits: board.limits, counts, now, width: W, theme, readAt: board.limitsReadAt })
      const foot = drawFooter({ headless: board.headless6h, agoMs: ago, width: W, theme })
      const rule = drawRule(W, theme)
      const ruleBox = (k: string) => <Box key={k}><Svg source={rule.svg} alt="" width={W} height={1} /></Box>
      return (
        <Box flexDirection="column">
          <Box key="top"><Svg source={top.svg} alt={top.alt} width={W} /></Box>
          {board.error && <Text color="red">Scan failed: {board.error}</Text>}
          {groups.map(({ g, rows }) => {
            const isCold = g === 'cold'
            const head = drawGroup({ label: GROUP_LABEL[g], n: rows.length, width: isCold ? RW : W, theme, rule: !isCold })
            const show = !isCold || coldOpen
            return (
              <Box key={`g-${g}`} flexDirection="column">
                {isCold ? (
                  <Box key="gh-cold" flexDirection="column">
                    {/* bottom-aligned: the label row's 20 px top padding sits above the button */}
                    <Box flexDirection="row" alignItems="flex-end">
                      <Svg source={head.svg} alt={head.alt} width={RW} />
                      <Box flexGrow={1} />
                      <Box paddingRight="sm"><Button key="cold-toggle" onPress={toggleCold}>{coldOpen ? 'Hide' : 'Show'}</Button></Box>
                    </Box>
                    {ruleBox('gh-cold-rule')}
                  </Box>
                ) : (
                  <Box key={`gh-${g}`}><Svg source={head.svg} alt={head.alt} width={W} /></Box>
                )}
                {show && rows.map((row, i) => {
                  const pic = drawRow({ row, now, width: RW, theme, note: noteFor(row) })
                  const isOpen = openRows.includes(row.sessionId)
                  const det = isOpen ? drawDetails({ items: detailItems(row, git[row.sessionId] ?? null, now), width: W, theme }) : null
                  return (
                    <Box key={`r-${row.sessionId}`} flexDirection="column" hover={hover}>
                      {i > 0 && ruleBox(`rl-${row.sessionId}`)}
                      <Box key={`rr-${row.sessionId}`} flexDirection="row" alignItems="flex-start">
                        <Svg source={pic.svg} alt={pic.alt} width={RW} />
                        <Box flexGrow={1} />
                        <Box flexDirection="column" alignItems="flex-end" gap="xs" paddingTop="sm" paddingRight="sm">
                          <Button key={`d-${row.sessionId}`} onPress={() => toggleRow(row)}>{isOpen ? 'Hide details' : 'Details'}</Button>
                          {compactBtn(row)}
                        </Box>
                      </Box>
                      {det && <Box key={`x-${row.sessionId}`}><Svg source={det.svg} alt={det.alt} width={W} /></Box>}
                    </Box>
                  )
                })}
              </Box>
            )
          })}
          {board.rows.length === 0 && <Text dimColor>No sessions found.</Text>}
          <Box key="foot"><Svg source={foot.svg} alt={foot.alt} width={W} /></Box>
        </Box>
      )
    }

    // Terminal: plain Text rows, bars drawn as text.
    return (
      <Box flexDirection="column">
        {board.limits.map(l => (
          <Text>{`${l.label} ${l.percent}% ${textBar(l.percent / 100, 10)}${resetsIn(l.resetsAt, now) ? ' ' + resetsIn(l.resetsAt, now) : ''}${board.limitsReadAt != null ? `, read ${fmtDur(now - board.limitsReadAt)} ago` : ''}`}</Text>
        ))}
        <Text dimColor>{`${counts.working} working, ${counts.yourturn} your turn, ${counts.agents} agent${counts.agents === 1 ? '' : 's'} running`}</Text>
        {board.error && <Text color="red">Scan failed: {board.error}</Text>}
        {groups.map(({ g, rows }) => (
          <Box key={`g-${g}`} flexDirection="column" marginTop={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>{`${GROUP_LABEL[g]} ${rows.length}`}</Text>
              {g === 'cold' && <Button key="cold-toggle" onPress={toggleCold}>{coldOpen ? 'Hide' : 'Show'}</Button>}
            </Box>
            {(g !== 'cold' || coldOpen) && rows.map(row => {
              const isOpen = openRows.includes(row.sessionId)
              return (
                <Box key={`r-${row.sessionId}`} flexDirection="column">
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text bold>{`* ${row.title}${row.isThis ? '  (this one)' : ''}`}</Text>
                    <Box flexDirection="row" gap={1}>
                      <Button key={`d-${row.sessionId}`} onPress={() => toggleRow(row)}>{isOpen ? 'Hide details' : 'Details'}</Button>
                      {compactBtn(row)}
                    </Box>
                  </Box>
                  {row.what && <Text wrap="truncate-end">{`  ${row.what}`}</Text>}
                  {noteFor(row) && <Text color={toneColor(noteFor(row)!.tone)} dimColor={noteFor(row)!.tone === 'dim'}>{`  ${noteFor(row)!.text}`}</Text>}
                  <Text dimColor wrap="truncate-end">{'  ' + metaParts(row, now).map(p => (p.bar === null ? p.text : `${p.text} ${textBar(p.bar, 10)}`)).join(' | ')}</Text>
                  {isOpen && detailItems(row, git[row.sessionId] ?? null, now).map(it => (
                    <Text>{`    ${it.k}: ${it.lines.join('; ')}${it.k === 'Context' && it.bar ? ' ' + textBar(it.bar.pct, 10) : ''}`}</Text>
                  ))}
                </Box>
              )
            })}
          </Box>
        ))}
        {board.rows.length === 0 && <Text dimColor>No sessions found.</Text>}
        <Text dimColor>{`${board.headless6h} background run${board.headless6h === 1 ? '' : 's'} in the last 6 hours   Updated ${Math.round(ago / 1000)}s ago`}</Text>
      </Box>
    )
  })
}

function toneColor(tone: string): string | undefined {
  return tone === 'red' ? 'red' : tone === 'amber' ? 'yellow' : tone === 'ok' ? 'green' : undefined
}

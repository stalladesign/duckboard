import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { A, B, engine, HOME, MIN, NOW, PANE, svgs } from './fixture'

// A compaction leaves at least one message: the summary.
const SUMMARY = [{ role: 'user' as const, text: 'Summary of the work so far.', toolUses: [] }]
const PEER = 'cccccccc-1111-4111-8111-000000000009'
const peer = { kind: 'peer' as const, plugin: 'duckboard' }

type Sent = { to: unknown; text: string }

function wire(on: On, o: { refuse?: string } = {}) {
  const sent: Sent[] = []
  on('session.send', (_$, e) => {
    sent.push({ to: e.to, text: e.text })
    return o.refuse ? { isDelivered: false as const, reason: o.refuse } : { isDelivered: true as const }
  })
  on('session.receive', (_$, e) => ({ text: e.text }))
  return sent
}

const rowAlt = async (ui: Parameters<typeof svgs>[0], sid: string) => (await svgs(ui)).find(a => a.includes(sid === A ? 'Login fix' : 'Board work'))
const idOf = (text: string) => /compact-request ([0-9a-f]{12})/.exec(text)?.[1] ?? ''

function prep(on: On, files: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { reads: [], argv: [] }, true, files)
  return clock
}

async function go($: { session: { start: (a: { cwd: string; surface: 'desktop'; isInteractive: boolean }) => Promise<unknown> } }, clock: { settle: () => Promise<void> }) {
  await $.session.start({ cwd: '/w/app', surface: 'desktop', isInteractive: true })
  await clock.settle()
}

test('another session: Ready, Sent, Compacting, Done', async ($, on) => {
  const sent = wire(on)
  const clock = prep(on)
  await go($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // only the idle, warm, live row offers it; never the working row
  expect((await ui.find({ key: `c-${A}` }))?.text).toBe('Compact')
  expect(await ui.find({ key: `c-${B}` })).toBeUndefined()

  await ui.press({ key: `c-${A}` })
  expect(sent.length).toBe(1)
  expect(sent[0]!.to).toBe(A)
  expect(sent[0]!.text).toMatch(new RegExp(`^duckboard compact-request [0-9a-f]{12} from ${B}$`))
  expect(await rowAlt(ui, A)).toContain('Request sent. Waiting for the session to start it.')
  expect(await ui.find({ key: `c-${A}` })).toBeUndefined()

  const id = idOf(sent[0]!.text)
  const r1 = await $.session.receive({ origin: peer, text: `duckboard compact-started ${id}` })
  expect(r1.consumed).toBe('duckboard compact-started')
  expect(await rowAlt(ui, A)).toContain('Compacting. Do not send this session a message.')
  await $.session.receive({ origin: peer, text: `<cross-session-message>\nduckboard compact-result ${id} ok 182000 21000\n</cross-session-message>` })
  expect(await rowAlt(ui, A)).toContain('Compacted just now: 182k to 21k tokens. Cache is fresh.')
  await clock.advance(10 * MIN + 6000)
  expect(await rowAlt(ui, A)).not.toContain('Compacted just now')
  await ui.unmount()
})

test('a refused send shows the engine reason and Retry; a late first result still lands', async ($, on) => {
  const sent = wire(on, { refuse: 'Auto mode could not reach a verdict for this message' })
  const clock = prep(on)
  await go($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `c-${A}` })
  expect(await rowAlt(ui, A)).toContain('Failed: Auto mode could not reach a verdict for this message')
  expect(await rowAlt(ui, A)).not.toContain('not running')
  expect((await ui.find({ key: `c-${A}` }))?.text).toBe('Retry')
  await ui.press({ key: `c-${A}` })
  expect(sent.length).toBe(2)
  const first = idOf(sent[0]!.text)
  expect(idOf(sent[1]!.text)).not.toBe(first)
  await $.session.receive({ origin: peer, text: `duckboard compact-result ${first} ok 182000 20000` })
  expect(await rowAlt(ui, A)).toContain('Compacted just now: 182k to 20k tokens.')
  await ui.unmount()
})

test('no answer in 30 seconds; Busy and Compacting time out after 10 minutes', async ($, on) => {
  const sent = wire(on)
  const clock = prep(on)
  await go($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `c-${A}` })
  await clock.advance(36_000)
  expect(await rowAlt(ui, A)).toContain('No answer in 30 seconds.')
  await ui.press({ key: `c-${A}` })
  await $.session.receive({ origin: peer, text: `duckboard compact-queued ${idOf(sent[1]!.text)}` })
  expect(await rowAlt(ui, A)).toContain('Busy. It compacts when this turn ends.')
  await clock.advance(10 * MIN + 6000)
  expect(await rowAlt(ui, A)).toContain('No result in 10 minutes.')
  await ui.unmount()
})

test('receiver: an idle session compacts and answers started, then the counts', async ($, on) => {
  const sent = wire(on)
  const clock = prep(on)
  let compacts = 0
  on('session.compact', () => {
    compacts++
    return { messages: SUMMARY, tokensBefore: 150_000, tokensAfter: 18_000 }
  })
  await go($, clock)
  const r = await $.session.receive({ origin: peer, text: `duckboard compact-request 0123456789ab from ${PEER}` })
  expect(r.consumed).toBe('duckboard compact-request')
  await clock.settle()
  expect(compacts).toBe(1)
  expect(sent.map(s => s.text)).toEqual(['duckboard compact-started 0123456789ab', 'duckboard compact-result 0123456789ab ok 150000 18000'])
  expect(sent.every(s => s.to === PEER)).toBe(true)
})

test('receiver: mid-turn it answers queued and compacts when the turn ends', async ($, on) => {
  const sent = wire(on)
  const clock = prep(on)
  let compacts = 0
  on('session.compact', () => {
    compacts++
    return { messages: SUMMARY, tokensBefore: 90_000, tokensAfter: 9000 }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  await go($, clock)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.session.receive({ origin: peer, text: `duckboard compact-request 0123456789ab from ${PEER}` })
  await clock.settle()
  expect(compacts).toBe(0)
  expect(sent.map(s => s.text)).toEqual(['duckboard compact-queued 0123456789ab'])
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' } as Parameters<typeof $.turn.complete>[0])
  await clock.settle()
  expect(compacts).toBe(1)
  expect(sent.at(-1)?.text).toBe('duckboard compact-result 0123456789ab ok 90000 9000')
})

test('receiver: headless refuses the compact call, so it runs /compact and reports its counts', async ($, on) => {
  const sent = wire(on)
  const clock = prep(on)
  let isCommand = false
  const ran: string[] = []
  let release = () => {}
  const gate = new Promise<void>(r => (release = r))
  on('session.compact', () => {
    // Before /compact runs, the call is refused (a throw here leaves the kit's bottom to reject it).
    if (!isCommand) throw new Error('session.compact is not available in a headless session')
    return { messages: SUMMARY, tokensBefore: 120_000, tokensAfter: 15_000 }
  })
  on('command.run', { command: 'compact' }, async (_$, e) => {
    ran.push(e.command)
    isCommand = true
    await gate
    return { text: 'Compacted' }
  })
  await go($, clock)
  await $.session.receive({ origin: peer, text: `duckboard compact-request 0123456789ab from ${PEER}` })
  await clock.settle()
  expect(ran).toEqual(['compact'])
  // what /compact causes in a session: the session.compact event, seen by the mod's hook
  await $.session.compact({ trigger: 'manual', messages: SUMMARY } as Parameters<typeof $.session.compact>[0])
  release()
  await clock.settle()
  expect(sent.map(s => s.text)).toEqual(['duckboard compact-started 0123456789ab', 'duckboard compact-result 0123456789ab ok 120000 15000'])
})

test('receiver: a failure is reported with its reason', async ($, on) => {
  const sent = wire(on)
  const clock = prep(on)
  on('session.compact', () => ({ skip: 'a PreCompact hook blocked it' }))
  await go($, clock)
  await $.session.receive({ origin: peer, text: `duckboard compact-request 0123456789ab from ${PEER}` })
  await clock.settle()
  expect(sent.at(-1)?.text).toBe('duckboard compact-result 0123456789ab fail a PreCompact hook blocked it')
})

test('everything else goes on: other text, other origins, near-miss lines', async ($, on) => {
  const sent = wire(on)
  const clock = prep(on)
  for (const m of [
    { origin: peer, text: 'can you compact please' },
    { origin: peer, text: `duckboard compact-request 0123456789ab from ${PEER} now` },
    { origin: { kind: 'bridge' as const }, text: `duckboard compact-request 0123456789ab from ${PEER}` },
    { origin: { kind: 'peer' as const, teammate: 'x', isVerified: true }, text: `duckboard compact-request 0123456789ab from ${PEER}` },
  ]) {
  await go($, clock)
    const r = await $.session.receive(m as Parameters<typeof $.session.receive>[0])
    expect(r.consumed).toBeUndefined()
    expect(r.text).toBe(m.text)
  }
  expect(sent.length).toBe(0)
})

const idleThis = { [`${HOME}/.claude/sessions/101.json`]: JSON.stringify({ pid: 101, sessionId: B, status: 'idle', kind: 'interactive', name: 'Board work', nameSource: 'user', updatedAt: 1, statusUpdatedAt: NOW - MIN, procStart: 'Thu Jan  1 11:00:00 2026' }) }

test('this session on the desktop: compact is refused headless, /compact runs, Done', async ($, on) => {
  wire(on)
  const clock = prep(on, idleThis)
  let isCommand = false
  let release = () => {}
  const gate = new Promise<void>(r => (release = r))
  on('session.compact', () => {
    if (!isCommand) throw new Error('not available in a headless session')
    return { messages: SUMMARY, tokensBefore: 127_000, tokensAfter: 21_000 }
  })
  on('command.run', { command: 'compact' }, async () => {
    isCommand = true
    await gate
    return { text: 'Compacted' }
  })
  await go($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const pressed = ui.press({ key: `c-${B}` })
  await clock.settle()
  expect(await rowAlt(ui, B)).toContain('Compacting. Do not send this session a message.')
  await $.session.compact({ trigger: 'manual', messages: SUMMARY } as Parameters<typeof $.session.compact>[0])
  release()
  await pressed
  expect(await rowAlt(ui, B)).toContain('Compacted just now: 127k to 21k tokens. Cache is fresh.')
  await ui.unmount()
})

test('this session: /compact that compacts nothing is a failure, not a silent Done', async ($, on) => {
  wire(on)
  const clock = prep(on, idleThis)
  on('session.compact', () => {
    throw new Error('not available in a headless session')
  })
  on('command.run', { command: 'compact' }, () => ({ text: '' }))
  await go($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `c-${B}` })
  expect(await rowAlt(ui, B)).toMatch(/Failed: \/compact ran but no compaction followed/)
  await ui.unmount()
})

test('this session on the terminal: the real compact error is the answer, no /compact', async ($, on) => {
  wire(on)
  const clock = prep(on, idleThis)
  const ran: string[] = []
  on('session.compact', () => {
    // The kit's bottom then rejects the call; on the terminal that rejection is the answer.
    throw new Error('Cannot compact while a turn is running')
  })
  on('command.run', { command: 'compact' }, () => {
    ran.push('compact')
    return { text: '' }
  })
  await go($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `c-${B}` })
  expect(ran).toEqual([])
  const line = await ui.find({ type: 'Text', text: /Failed: / })
  expect(line?.text).toMatch(/Failed: \S/)
  expect(line?.text).not.toContain('not running')
  expect((await ui.find({ key: `c-${B}` }))?.text).toBe('Retry')
  await ui.unmount()
})

test('auto compact: after N idle minutes, only above the minimum size, only while warm', { options: { autoCompact: true, autoCompactIdleMinutes: 50, autoCompactMinTokens: 100_000 } }, async ($, on) => {
  const sent = wire(on)
  const clock = prep(on)
  await go($, clock)
  expect(sent.length).toBe(0) // idle 19 minutes
  await clock.advance(30 * MIN) // idle 49 minutes
  expect(sent.length).toBe(0)
  await clock.advance(2 * MIN) // idle 51 minutes, 8 minutes of cache left
  expect(sent.map(s => s.to)).toEqual([A])
  expect(sent[0]!.text).toMatch(/^duckboard compact-request [0-9a-f]{12} from /)
  await clock.advance(5 * MIN) // no second request for the same idle stretch
  expect(sent.length).toBe(1)
})

test('auto compact: never at or past the cache lifetime', { options: { autoCompact: true, autoCompactIdleMinutes: 60 } }, async ($, on) => {
  const sent = wire(on)
  const clock = prep(on)
  await go($, clock)
  await clock.advance(40 * MIN)
  expect(sent.length).toBe(0)
})

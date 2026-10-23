import { expect, test } from 'claude-code/testing'

import { buildRows, liveSessions, parsePs, pickFiles, pickLimits, toAgent, toLimits, CACHE_TTL_MS, type RegEntry } from './board'
import { parseTranscript } from './transcript'
import { cacheLabel, contextLine, fmtDur, fmtTokens, metaContext, resetsIn } from './format'

const NOW = Date.parse('2026-01-01T12:00:00Z')
const MIN = 60_000
const reg = (o: Partial<RegEntry>): RegEntry => ({
  pid: 1, sessionId: 's', cwd: '/w/app', kind: 'interactive', entrypoint: 'claude-desktop', name: null, nameSource: null,
  status: 'idle', updatedAt: 0, statusUpdatedAt: 0, procStart: 'Thu Jan  1 09:00:00 2026', ...o,
})
const facts = (o: { sessionId: string; text?: string; minAgo: number; tokens?: number; model?: string; isClaudes?: boolean; entry?: string; title?: string }) => {
  const at = new Date(NOW - o.minAgo * MIN).toISOString()
  const rows = [
    o.title ? JSON.stringify({ type: 'custom-title', customTitle: o.title }) : '',
    JSON.stringify({ type: 'user', timestamp: at, sessionId: o.sessionId, cwd: '/w/' + o.sessionId, entrypoint: o.entry ?? 'claude-desktop', message: { role: 'user', content: 'hi' } }),
    o.isClaudes === false ? '' : JSON.stringify({ type: 'assistant', timestamp: at, sessionId: o.sessionId, message: { role: 'assistant', model: o.model ?? 'claude-opus-5-5', content: [{ type: 'text', text: o.text ?? 'Did the thing.' }], usage: { input_tokens: o.tokens ?? 1000 } } }),
  ]
  return parseTranscript(rows.join('\n'))
}

test('the cache lifetime is the measured 60 minutes', () => {
  expect(CACHE_TTL_MS).toBe(60 * MIN)
})

test('ps output: pid and start time', () => {
  const m = parsePs('  101 Thu Jan  1 09:00:00 2026\n  202 Thu Jan  1 10:30:00 2026\n')
  expect(m.get(101)).toBe('Thu Jan  1 09:00:00 2026')
  expect(m.get(202)).toBe('Thu Jan  1 10:30:00 2026')
})

test('live registry: dead pid out, reused pid out, newest entry wins', () => {
  const ps = parsePs('  1 Thu Jan  1 09:00:00 2026\n  2 Thu Jan  1 11:00:00 2026\n  4 Thu Jan  1 09:00:00 2026\n')
  const live = liveSessions(
    [
      reg({ pid: 1, sessionId: 'a', updatedAt: 5 }),
      reg({ pid: 2, sessionId: 'b', procStart: 'Thu Jan  1 08:00:00 2026' }), // pid reused by another process
      reg({ pid: 3, sessionId: 'c' }), // dead
      reg({ pid: 4, sessionId: 'a', updatedAt: 9, status: 'busy' }), // newer entry for the same session
    ],
    ps,
  )
  expect([...live.keys()]).toEqual(['a'])
  expect(live.get('a')?.status).toBe('busy')
})

test('file pick: live any age, 40 recent, 60 older up to 7 days', () => {
  const files = Array.from({ length: 120 }, (_, i) => ({ sessionId: 's' + i, path: '/p/s' + i + '.jsonl', mtimeMs: NOW - i * 10 * MIN, size: 10 }))
  files.push({ sessionId: 'old-live', path: '/p/old.jsonl', mtimeMs: NOW - 30 * 24 * 60 * MIN, size: 10 })
  files.push({ sessionId: 'too-old', path: '/p/too.jsonl', mtimeMs: NOW - 8 * 24 * 60 * MIN, size: 10 })
  const picked = pickFiles(files, new Set(['old-live']), NOW)
  expect(picked.recent.length).toBe(38) // 37 within 6 hours (0..360 min), plus the live one
  expect(picked.recent.map(f => f.sessionId)).toContain('old-live')
  expect(picked.old.length).toBe(60)
  expect(picked.old.map(f => f.sessionId)).not.toContain('too-old')
})

test('groups: working, your turn, cold; closed is always cold; headless is only counted', () => {
  const live = new Map([
    ['busy', reg({ sessionId: 'busy', status: 'busy' })],
    ['warm', reg({ sessionId: 'warm', status: 'idle', statusUpdatedAt: NOW - 20 * MIN })],
    ['stale', reg({ sessionId: 'stale', status: 'idle' })],
    ['agent', reg({ sessionId: 'agent', status: 'idle' })],
  ])
  const { rows, headless6h } = buildRows({
    now: NOW, thisId: 'busy', live, addressName: '', thisUsage: { tokens: 127000, window: 1_000_000 },
    sessions: [
      { facts: facts({ sessionId: 'busy', minAgo: 1 }), agents: [] },
      { facts: facts({ sessionId: 'warm', minAgo: 20 }), agents: [] },
      { facts: facts({ sessionId: 'stale', minAgo: 90 }), agents: [] },
      { facts: facts({ sessionId: 'agent', minAgo: 90 }), agents: [{ id: 'x', name: 'Explore', model: 'haiku', startedAt: NOW - 2 * MIN, isRunning: true, lastWriteAt: NOW }] },
      { facts: facts({ sessionId: 'closed', minAgo: 5 }), agents: [] },
      { facts: facts({ sessionId: 'hl', minAgo: 5, entry: 'sdk-cli' }), agents: [] },
    ],
  })
  const g = Object.fromEntries(rows.map(r => [r.sessionId, r.group]))
  expect(g).toEqual({ busy: 'working', warm: 'yourturn', stale: 'cold', agent: 'working', closed: 'cold' })
  expect(headless6h).toBe(1)
  const busy = rows.find(r => r.sessionId === 'busy')
  expect(busy?.isThis).toBe(true)
  expect(busy?.tokens).toBe(127000)
  expect(busy?.window).toBe(1_000_000)
  expect(rows.find(r => r.sessionId === 'agent')?.agentsRunning).toBe(1)
})

test('title: a name I set, else the transcript title, else the project', () => {
  const live = new Map([
    ['a', reg({ sessionId: 'a', name: 'Mine', nameSource: 'user' })],
    ['b', reg({ sessionId: 'b', name: 'Auto', nameSource: 'auto' })],
  ])
  const { rows } = buildRows({
    now: NOW, thisId: 'z', live, addressName: '', thisUsage: null,
    sessions: [
      { facts: facts({ sessionId: 'a', minAgo: 1, title: 'T' }), agents: [] },
      { facts: facts({ sessionId: 'b', minAgo: 1, title: 'From transcript' }), agents: [] },
      { facts: facts({ sessionId: 'c', minAgo: 1 }), agents: [] },
    ],
  })
  expect(rows.map(r => r.title)).toEqual(['Mine', 'From transcript', 'c'])
})

test('window: engine value for this one, 1M for [1m] or over 200k, else unknown', () => {
  const { rows } = buildRows({
    now: NOW, thisId: 'z', live: new Map(), addressName: '', thisUsage: null,
    sessions: [
      { facts: facts({ sessionId: 'big', minAgo: 1, tokens: 232000 }), agents: [] },
      { facts: facts({ sessionId: 'tag', minAgo: 1, tokens: 9000, model: 'claude-opus-5-5[1m]' }), agents: [] },
      { facts: facts({ sessionId: 'small', minAgo: 1, tokens: 119000 }), agents: [] },
    ],
  })
  expect(rows.map(r => r.window)).toEqual([1_000_000, 1_000_000, null])
})

test('agents: running by a recent write or an open tool call under an hour', () => {
  const a = toAgent({ id: 'a1', mtimeMs: NOW - 30_000, meta: { description: 'Build it', model: 'sonnet' }, facts: null }, NOW)
  expect(a).toEqual({ id: 'a1', name: 'Build it', model: 'sonnet', startedAt: null, isRunning: true, lastWriteAt: NOW - 30_000 })
  const openCall = parseTranscript(JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - 30 * MIN).toISOString(), message: { role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }))
  const b = toAgent({ id: 'a2', mtimeMs: NOW - 30 * MIN, meta: { agentType: 'Explore' }, facts: openCall }, NOW)
  expect(b.isRunning).toBe(true)
  expect(b.name).toBe('Explore')
  expect(b.model).toBe('claude-haiku-5-5')
  const stale = parseTranscript(JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - 70 * MIN).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }))
  expect(toAgent({ id: 'a3', mtimeMs: NOW - 70 * MIN, meta: null, facts: stale }, NOW).isRunning).toBe(false)
})

test('limits: only what the engine gives', () => {
  expect(toLimits([{ kind: 'five_hour', percentUsed: 6, resetsAt: '2026-01-01T16:10:00Z' }, { kind: 'seven_day', percentUsed: 18 }])).toEqual([
    { label: '5-hour limit', percent: 6, resetsAt: '2026-01-01T16:10:00Z' },
    { label: 'Weekly', percent: 18, resetsAt: null },
  ])
  expect(toLimits([])).toEqual([])
})

test('format: tokens, durations, cache, context', () => {
  expect(fmtTokens(182_400)).toBe('182k')
  expect(fmtTokens(1_000_000)).toBe('1M')
  expect(fmtTokens(950)).toBe('950')
  expect(fmtDur(30_000)).toBe('<1m')
  expect(fmtDur(41 * MIN)).toBe('41m')
  expect(fmtDur(250 * MIN)).toBe('4h 10m')
  expect(fmtDur(23 * 60 * MIN)).toBe('23h')
  expect(fmtDur(50 * 60 * MIN)).toBe('2d')
  expect(cacheLabel(41 * MIN + 5000)).toBe('Cache 41m')
  expect(cacheLabel(40_000)).toBe('Cache <1m')
  expect(cacheLabel(-1)).toBe(null)
  expect(contextLine(182_000, 1_000_000)).toBe('182k of 1M tokens (18%)')
  expect(contextLine(119_000, null)).toBe('119k tokens')
  expect(contextLine(null, null)).toBe('unknown')
  expect(metaContext(232_000, 1_000_000)).toBe('23%')
  expect(metaContext(119_000, null)).toBe('119k tokens')
  expect(resetsIn('2026-01-01T16:10:00Z', NOW)).toBe('resets in 4h 10m')
  expect(resetsIn(null, NOW)).toBe(null)
})

test('limits: this session\'s reading first, else the last real one still inside its window', () => {
  const fresh = [{ label: '5-hour limit', percent: 32, resetsAt: '2026-01-01T15:00:00Z' }]
  expect(pickLimits(fresh, null, NOW)).toEqual({ limits: fresh, readAt: null, save: { limits: fresh, at: NOW } })
  const stored = { limits: [fresh[0]!, { label: 'Weekly', percent: 21, resetsAt: '2026-01-01T11:00:00Z' }, { label: 'x', percent: 1, resetsAt: null }], at: NOW - 12 * MIN }
  // the weekly window already reset and the third has no reset time: both dropped
  expect(pickLimits([], stored, NOW)).toEqual({ limits: [fresh[0]], readAt: NOW - 12 * MIN, save: null })
  expect(pickLimits([], null, NOW)).toEqual({ limits: [], readAt: null, save: null })
  // anything else in the store is not a reading
  expect(pickLimits([], { limits: 'nope', at: 1 } as never, NOW)).toEqual({ limits: [], readAt: null, save: null })
  expect(pickLimits([], 'junk' as never, NOW)).toEqual({ limits: [], readAt: null, save: null })
})

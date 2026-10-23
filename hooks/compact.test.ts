import { expect, test } from 'claude-code/testing'

import type { CompactState, Row } from '../types'
import { canCompact, compactNote, formatLine, onReply, parseLine, request, showButton, tick, unwrap } from './compact'

const NOW = Date.parse('2026-01-01T12:00:00Z')
const MIN = 60_000
const SID = '0b1c2d3e-4f50-4617-8899-aabbccddeeff'
const row = (o: Partial<Row> = {}): Row => ({
  sessionId: 's1', title: 't', isThis: false, group: 'yourturn', isLive: true, isIdle: true, cwd: null, branch: null, what: null, lastTwo: [],
  tokens: 182_000, window: 1_000_000, lastReplyAt: NOW - 20 * MIN, idleSince: NOW - 20 * MIN, agents: [], agentsRunning: 0, agentsDoneHour: 0, ticket: null, test: null, ...o,
})

test('protocol lines: one line each, exact, with a random id', () => {
  expect(formatLine({ kind: 'request', id: 'a1b2c3d4e5f6', from: SID })).toBe(`duckboard compact-request a1b2c3d4e5f6 from ${SID}`)
  expect(formatLine({ kind: 'started', id: 'a1b2c3d4e5f6' })).toBe('duckboard compact-started a1b2c3d4e5f6')
  expect(formatLine({ kind: 'queued', id: 'a1b2c3d4e5f6' })).toBe('duckboard compact-queued a1b2c3d4e5f6')
  expect(formatLine({ kind: 'result', id: 'a1b2c3d4e5f6', ok: true, before: 182000, after: 21000 })).toBe('duckboard compact-result a1b2c3d4e5f6 ok 182000 21000')
  expect(formatLine({ kind: 'result', id: 'a1b2c3d4e5f6', ok: true, before: null, after: null })).toBe('duckboard compact-result a1b2c3d4e5f6 ok unknown unknown')
  expect(formatLine({ kind: 'result', id: 'a1b2c3d4e5f6', ok: false, reason: 'a turn\nis running' })).toBe('duckboard compact-result a1b2c3d4e5f6 fail a turn is running')
  for (const l of [`duckboard compact-request a1b2c3d4e5f6 from ${SID}`, 'duckboard compact-started a1b2c3d4e5f6', 'duckboard compact-result a1b2c3d4e5f6 ok 182000 21000', 'duckboard compact-result a1b2c3d4e5f6 fail hook said no']) {
    expect(formatLine(parseLine(l)!)).toBe(l)
  }
  expect(parseLine('please compact a1b2c3d4e5f6')).toBe(null)
  expect(parseLine('duckboard compact-request a1b2c3d4e5f6 from not-a-session')).toBe(null)
  expect(parseLine('duckboard compact-started a1b2c3d4e5f6 and more')).toBe(null)
  expect(parseLine('duckboard compact-started a1b2c3d4e5f6\nsecond line')).toBe(null)
  expect(parseLine('duckboard compact-started A1B2')).toBe(null)
})

test('envelope: the protocol line alone inside one wrapper tag', () => {
  expect(unwrap('duckboard compact-started a1b2c3d4e5f6')).toBe('duckboard compact-started a1b2c3d4e5f6')
  expect(unwrap('<cross-session-message from="x">\nduckboard compact-started a1b2c3d4e5f6\n</cross-session-message>')).toBe('duckboard compact-started a1b2c3d4e5f6')
  expect(unwrap('<a>duckboard compact-started a1b2c3d4e5f6</b>')).toBe('<a>duckboard compact-started a1b2c3d4e5f6</b>')
  expect(parseLine(unwrap('<m>hi duckboard compact-started a1b2c3d4e5f6</m>'))).toBe(null)
})

test('who can compact: idle, warm, live main rows only', () => {
  expect(canCompact(row())).toBe(true)
  expect(canCompact(row({ group: 'working', isIdle: false }))).toBe(false)
  expect(canCompact(row({ group: 'cold' }))).toBe(false)
  expect(canCompact(row({ isLive: false, group: 'cold' }))).toBe(false)
})

test('states: sent, started, queued, result; retry keeps the first id open', () => {
  let s: CompactState | null = request(null, 'id1', NOW)
  expect(s).toEqual({ kind: 'sent', ids: ['id1'], at: NOW, reason: null, before: null, after: null })
  expect(compactNote(s, row(), NOW)).toEqual({ text: 'Request sent. Waiting for the session to start it.', tone: 'dim' })
  s = tick(s, NOW + 31_000)
  expect(s?.kind).toBe('noanswer')
  expect(compactNote(s, row(), NOW + 31_000)).toEqual({ text: 'No answer in 30 seconds.', tone: 'red' })
  expect(showButton(row(), s)).toBe('Retry')
  s = request(s, 'id2', NOW + 40_000)
  expect(s.ids).toEqual(['id1', 'id2'])
  // the late answer to the first request still lands
  s = onReply(s, { kind: 'started', id: 'id1' }, NOW + 41_000)
  expect(s?.kind).toBe('compacting')
  expect(compactNote(s, row(), NOW)?.text).toBe('Compacting. Do not send this session a message.')
  expect(showButton(row(), s)).toBe(null)
  s = onReply(s, { kind: 'result', id: 'id2', ok: true, before: 182_000, after: 21_000 }, NOW + 60_000)
  expect(s).toEqual({ kind: 'done', ids: [], at: NOW + 60_000, reason: null, before: 182_000, after: 21_000 })
  expect(compactNote(s, row(), NOW + 60_000)).toEqual({ text: 'Compacted just now: 182k to 21k tokens. Cache is fresh.', tone: 'ok' })
  expect(tick(s, NOW + 60_000 + 10 * MIN - 1)?.kind).toBe('done')
  expect(tick(s, NOW + 60_000 + 10 * MIN + 1)).toBe(null)
})

test('a reply for an id that is not open changes nothing', () => {
  const s = request(null, 'id1', NOW)
  expect(onReply(s, { kind: 'started', id: 'other' }, NOW)).toBe(s)
  expect(onReply(null, { kind: 'started', id: 'other' }, NOW)).toBe(null)
})

test('busy, timeouts, failure with the real reason', () => {
  let s: CompactState | null = onReply(request(null, 'q', NOW), { kind: 'queued', id: 'q' }, NOW + 1000)
  expect(s?.kind).toBe('busy')
  expect(compactNote(s, row(), NOW)?.text).toBe('Busy. It compacts when this turn ends.')
  expect(tick(s, NOW + 9 * MIN)?.kind).toBe('busy')
  s = tick(s, NOW + 11 * MIN)
  expect(compactNote(s, row(), NOW)).toEqual({ text: 'No result in 10 minutes.', tone: 'red' })
  const f = onReply(request(null, 'f', NOW), { kind: 'result', id: 'f', ok: false, reason: 'Auto mode could not reach a verdict' }, NOW)
  expect(compactNote(f, row(), NOW)).toEqual({ text: 'Failed: Auto mode could not reach a verdict', tone: 'red' })
  expect(showButton(row(), f)).toBe('Retry')
})

test('done with an unknown after count reads it from the next scan', () => {
  const s = onReply(request(null, 'x', NOW), { kind: 'result', id: 'x', ok: true, before: 182_000, after: null }, NOW)
  expect(compactNote(s, row({ tokens: 182_000 }), NOW)?.text).toBe('Compacted just now: 182k to unknown tokens. Cache is fresh.')
  expect(compactNote(s, row({ tokens: 20_500, lastReplyAt: NOW + 1000 }), NOW + 2000)?.text).toBe('Compacted just now: 182k to 21k tokens. Cache is fresh.')
})

test('ready and ready-low', () => {
  expect(compactNote(null, row(), NOW)).toBe(null)
  expect(showButton(row(), null)).toBe('Compact')
  expect(compactNote(null, row({ lastReplyAt: NOW - 52 * MIN }), NOW)).toEqual({ text: 'Cache ends in 8 min', tone: 'amber' })
  expect(showButton(row({ group: 'cold' }), null)).toBe(null)
})

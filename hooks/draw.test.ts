import { expect, test } from 'claude-code/testing'

import type { Row } from '../types'
import { CACHE_TTL_MS } from './board'
import { detailItems, drawDetails, drawFooter, drawGroup, drawRow, drawRule, drawTop, fit, metaParts, PALETTE, textBar, textWidth, wrap, SPEC } from './draw'

const NOW = Date.parse('2026-01-01T12:00:00Z')
const MIN = 60_000
const row = (o: Partial<Row> = {}): Row => ({
  sessionId: 's1', title: 'Fix the login page', isThis: false, group: 'yourturn', isLive: true, isIdle: true, cwd: '/w/app', branch: 'main',
  what: 'Done. The tests pass.', lastTwo: ['Done. The tests pass.', 'Next: deploy.'], tokens: 182_000, window: 1_000_000,
  lastReplyAt: NOW - 19 * MIN, idleSince: NOW - 19 * MIN, agents: [], agentsRunning: 0, agentsDoneHour: 0, ticket: null, test: null, ...o,
})

test('spec values match the mockup', () => {
  expect(SPEC).toEqual({ padX: 12, padY: 10, gap: 4, fsTitle: 13, fsBody: 12, fsMeta: 11, fsCount: 13, lh: 1.35, dot: 8, barH: 4, cacheBarW: 36, rule: 1 })
  expect(PALETTE.light.working).toBe('#2f6fdf')
  expect(PALETTE.dark.bg).toBe('#1e1e1e')
})

test('text width grows with length and weight; fit cuts with ... under the width', () => {
  expect(textWidth('iiii', 12)).toBeLessThan(textWidth('MMMM', 12))
  expect(textWidth('abc', 13, true)).toBeGreaterThan(textWidth('abc', 13))
  const long = 'The helper session finished. It committed abc1234 on its own branch and did not push it.'
  const cut = fit(long, 200, 12)
  expect(cut.endsWith('...')).toBe(true)
  expect(textWidth(cut, 12)).toBeLessThanOrEqual(200)
  expect(fit('short', 200, 12)).toBe('short')
  expect(fit('anything', 5, 12)).toBe('')
})

test('wrap keeps whole words and cuts the last line', () => {
  const lines = wrap('one two three four five six seven eight nine ten eleven twelve', 80, 12, 2)
  expect(lines.length).toBe(2)
  expect(lines[1]?.endsWith('...')).toBe(true)
  for (const l of lines) expect(textWidth(l, 12)).toBeLessThanOrEqual(80)
})

test('meta line: agents, cache bar, context; amber under 10 minutes; <1m', () => {
  expect(metaParts(row(), NOW).map(p => p.text)).toEqual(['No agents', 'Cache 41m', '18%'])
  const low = metaParts(row({ lastReplyAt: NOW - 52 * MIN }), NOW)
  expect(low[1]).toEqual({ text: 'Cache 8m', tone: 'amber', bar: 8 / 60 })
  expect(metaParts(row({ lastReplyAt: NOW - CACHE_TTL_MS + 20_000 }), NOW)[1]?.text).toBe('Cache <1m')
  expect(metaParts(row({ agentsRunning: 2 }), NOW)[0]?.text).toBe('2 agents running')
  expect(metaParts(row({ agentsRunning: 1 }), NOW)[0]?.text).toBe('1 agent running')
})

test('meta line: cold row shows idle time; working with a cold cache says what it rewrites', () => {
  expect(metaParts(row({ group: 'cold', lastReplyAt: NOW - 90 * MIN, idleSince: NOW - 43 * MIN, tokens: 291_000 }), NOW).map(p => p.text)).toEqual(['Idle 43m', '29%'])
  const w = metaParts(row({ group: 'working', lastReplyAt: NOW - 90 * MIN, tokens: 291_000 }), NOW)
  expect(w[1]).toEqual({ text: 'Cold: next turn rewrites 291k', tone: 'amber', bar: null })
  expect(metaParts(row({ tokens: 119_000, window: null }), NOW)[2]?.text).toBe('119k tokens')
  expect(metaParts(row({ tokens: null, window: null }), NOW).length).toBe(2)
})

test('details: known facts only', () => {
  const items = detailItems(row({ ticket: 'ABC-12', test: { kind: 'passed', at: NOW - 5 * MIN }, agentsDoneHour: 3, agentsRunning: 1, agents: [{ id: 'a', name: 'Explore', model: 'haiku', startedAt: NOW - 72_000, isRunning: true, lastWriteAt: NOW }] }), { text: '2 not pushed', at: NOW }, NOW)
  expect(items.map(i => i.k)).toEqual(['Last update', 'Context', 'Cache', 'Agents', 'Ticket', 'Git', 'Tests'])
  expect(items.find(i => i.k === 'Context')?.lines).toEqual(['182k of 1M tokens (18%)'])
  expect(items.find(i => i.k === 'Cache')?.lines).toEqual(['41 min left'])
  expect(items.find(i => i.k === 'Agents')?.lines).toEqual(['Explore, haiku, 1m', '3 agents done in the last hour'])
  expect(items.find(i => i.k === 'Tests')?.lines).toEqual(['Tested 5m ago'])
  const bare = detailItems(row({ group: 'cold', lastReplyAt: NOW - 2 * 60 * MIN }), null, NOW)
  expect(bare.map(i => i.k)).toEqual(['Last update', 'Context', 'Cache', 'Agents'])
  expect(bare.find(i => i.k === 'Cache')?.lines).toEqual(['Cold. The next turn rewrites the context.'])
  expect(bare.find(i => i.k === 'Agents')?.lines).toEqual(['No agents in the last hour'])
  expect(detailItems(row({ test: { kind: 'failed', at: NOW } }), { text: 'Pushed', at: NOW }, NOW).find(i => i.k === 'Tests')?.lines).toEqual(['Tests failed'])
  expect(detailItems(row({ test: { kind: 'running', at: NOW } }), null, NOW).find(i => i.k === 'Tests')?.lines).toEqual(['Testing'])
})

test('row svg: escaped, fitted, colored by group, small, with alt', () => {
  const r = drawRow({ row: row({ title: 'A <b> & "q" title that is far too long to ever fit in the row width at all', isThis: true }), now: NOW, width: 280, theme: 'light', note: null })
  expect(r.svg.startsWith('<svg')).toBe(true)
  expect(r.svg).toContain('&lt;b&gt; &amp;')
  expect(r.svg).not.toContain('<b>')
  expect(r.svg).toContain(PALETTE.light.yourturn)
  expect(r.svg).toContain('this one')
  expect(r.svg).toContain('font-size="13"')
  expect(r.svg.length).toBeLessThan(131072)
  expect(r.alt).toContain('Your turn')
  expect(r.alt).toContain('Cache 41m')
  expect(r.height).toBeGreaterThan(40)
  const dark = drawRow({ row: row({ group: 'cold' }), now: NOW, width: 280, theme: 'dark', note: { text: 'Request sent. Waiting for the session to start it.', tone: 'dim' } })
  expect(dark.svg).toContain(PALETTE.dark.cold)
  expect(dark.svg).toContain('Request sent.')
  expect(dark.height).toBeGreaterThan(r.height)
})

test('top: counts first in 13px, numbers semibold, then the limit bars; no rule under it', () => {
  const top = drawTop({ limits: [{ label: '5-hour limit', percent: 6, resetsAt: '2026-01-01T16:10:00Z' }, { label: 'Weekly', percent: 18, resetsAt: null }], counts: { working: 1, yourturn: 0, agents: 0 }, now: NOW, width: 428, theme: 'light' })
  const svg = top.svg
  expect(svg.indexOf('>working<')).toBeLessThan(svg.indexOf('5-hour limit 6%'))
  expect(svg).toContain('font-size="13" font-weight="600" fill="#1f1f1f">1</text>')
  expect(svg).toContain('font-size="13" fill="#1f1f1f">working</text>')
  expect(svg).toContain('font-size="13" fill="#e6e6e6">|</text>')
  expect(svg).toContain('resets in 4h 10m')
  expect(svg).not.toContain('height="1" fill')
  // 10 top, 16 count line, 12 under it, two limits of 8 + 14.85 + 3 + 4, 24 bottom: the Figma frame's 121.7
  expect(Math.abs(top.height - 121.7)).toBeLessThan(0.5)
  expect(top.alt).toBe('1 working, 0 your turn, 0 agents running. 5-hour limit 6%, resets in 4h 10m. Weekly 18%.')
  const none = drawTop({ limits: [], counts: { working: 0, yourturn: 0, agents: 0 }, now: NOW, width: 360, theme: 'light' })
  expect(none.svg).not.toContain('limit')
  // no bars: no room left for them
  expect(Math.abs(none.height - (10 + 16 + 24))).toBeLessThan(0.1)
  const old = drawTop({ limits: [{ label: '5-hour limit', percent: 32, resetsAt: '2026-01-01T14:59:00Z' }], counts: { working: 0, yourturn: 0, agents: 0 }, now: NOW, width: 428, theme: 'light', readAt: NOW - 12 * 60_000 })
  expect(old.svg).toContain('resets in 2h 59m, read 12m ago')
  expect(old.alt).toContain('5-hour limit 32%, resets in 2h 59m, read 12m ago.')
})

test('section label (Figma 1:1194): 20 top, 4 bottom, a rule below it when asked', () => {
  const g = drawGroup({ label: 'Working', n: 1, width: 428, theme: 'light', rule: true })
  expect(g.alt).toBe('Working, 1 session')
  expect(Math.abs(g.height - 39.85)).toBeLessThan(0.1)
  // the label text starts 20 below the top of its row
  expect(g.svg).toContain('y="30.7"')
  expect(g.svg).toContain('width="428" height="1" fill="#e6e6e6"')
  const cold = drawGroup({ label: 'Cold', n: 7, width: 300, theme: 'light', rule: false })
  expect(cold.svg).not.toContain('height="1" fill')
  expect(Math.abs(cold.height - 38.85)).toBeLessThan(0.1)
  expect(drawRule(428, 'dark').svg).toContain('fill="#333333"')
  expect(drawRule(428, 'dark').height).toBe(1)
})

test('rows carry no rule of their own; details and footer pictures', () => {
  expect(drawRow({ row: row(), now: NOW, width: 300, theme: 'light', note: null }).svg).not.toContain('height="1" fill')
  const det = drawDetails({ items: detailItems(row(), null, NOW), width: 280, theme: 'light' })
  expect(det.svg).toContain('Last update')
  expect(det.svg).toContain('41 min left')
  const foot = drawFooter({ headless: 0, agoMs: 4000, width: 360, theme: 'light' })
  expect(foot.svg).toContain('0 background runs in the last 6 hours')
  expect(foot.svg).toContain('Updated 4s ago')
})

test('terminal bars are plain ASCII', () => {
  expect(textBar(0.06, 10)).toBe('[#.........]')
  expect(textBar(1, 10)).toBe('[##########]')
  expect(textBar(0, 4)).toBe('[....]')
})

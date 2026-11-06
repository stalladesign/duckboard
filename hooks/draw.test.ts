import { expect, test } from 'claude-code/testing'

import type { Row } from '../types'
import { CACHE_TTL_MS } from './board'
import { detailItems, drawBar, drawCounts, drawDetails, drawGroup, drawLine, drawRow, drawRule, fit, footerLines, limitLine, metaParts, PALETTE, textBar, textWidth, wrap, SPEC } from './draw'

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
  const r = drawRow({ row: row({ title: 'A <b> & "q" title that is far too long to ever fit in the row width at all', isThis: true }), now: NOW, width: 280, note: null })
  expect(r.svg.startsWith('<svg')).toBe(true)
  expect(r.svg).toContain('&lt;b&gt; &amp;')
  expect(r.svg).not.toContain('<b>')
  expect(r.svg).toContain(`class="k-yourturn" fill="${PALETTE.light.yourturn}"`)
  // the dark colors ride along in the SVG's own media query
  expect(r.svg).toContain(`@media (prefers-color-scheme: dark){`)
  expect(r.svg).toContain(`.k-text{fill:${PALETTE.dark.text}}`)
  expect(r.svg).toContain('this one')
  expect(r.svg).toContain('font-size="13"')
  expect(r.svg.length).toBeLessThan(131072)
  expect(r.alt).toContain('Your turn')
  expect(r.alt).toContain('Cache 41m')
  expect(r.height).toBeGreaterThan(40)
  const cold = drawRow({ row: row({ group: 'cold' }), now: NOW, width: 280, note: { text: 'Request sent. Waiting for the session to start it.', tone: 'dim' } })
  expect(cold.svg).toContain(`.k-cold{fill:${PALETTE.dark.cold}}`)
  expect(cold.svg).toContain('Request sent.')
  expect(cold.height).toBeGreaterThan(r.height)
})

test('top: counts in 13px, numbers semibold, sized to themselves; limit lines say when they reset', () => {
  const c = drawCounts({ counts: { working: 1, yourturn: 0, agents: 0 } })
  expect(c.svg).toContain('font-size="13" font-weight="600" class="k-text" fill="#1f1f1f">1</text>')
  expect(c.svg).toContain('font-size="13" class="k-text" fill="#1f1f1f">working</text>')
  expect(c.svg).toContain('font-size="13" class="k-rule" fill="#e6e6e6">|</text>')
  expect(c.alt).toBe('1 working, 0 your turn, 0 agents running.')
  expect(c.height).toBe(26)
  expect(c.width).toBeLessThan(400)
  expect(limitLine({ label: '5-hour limit', percent: 6, resetsAt: '2026-01-01T16:10:00Z' }, NOW)).toEqual({ left: '5-hour limit 6%', right: 'resets in 4h 10m', alt: '5-hour limit 6%, resets in 4h 10m.' })
  expect(limitLine({ label: 'Weekly', percent: 18, resetsAt: null }, NOW)).toEqual({ left: 'Weekly 18%', right: null, alt: 'Weekly 18%.' })
  expect(limitLine({ label: '5-hour limit', percent: 32, resetsAt: '2026-01-01T14:59:00Z' }, NOW, NOW - 12 * 60_000).right).toBe('resets in 2h 59m, read 12m ago')
})

test('a line picture: as wide as its text, right-aligned against its own edge when asked', () => {
  const l = drawLine({ text: 'Weekly 18%', size: 11, ink: 'text', top: 8, bottom: 3 })
  expect(l.svg).toContain('x="12"')
  expect(Math.abs(l.height - (8 + 14.85 + 3))).toBeLessThan(0.1)
  const r = drawLine({ text: 'resets in 4h', size: 11, ink: 'dim', top: 8, end: true })
  expect(r.svg).toContain(`x="${r.width - 12}"`)
  expect(r.svg).toContain('text-anchor="end"')
})

test('rules span the width; bars are inset by the gutter', () => {
  const rule = drawRule(428)
  expect(rule.height).toBe(1)
  // an empty alt is not drawn on the desktop
  expect(rule.alt).not.toBe('')
  expect(rule.svg).toContain('width="428" height="1" class="k-rule"')
  // stretched to the column's real width on the desktop
  expect(rule.svg).toContain('preserveAspectRatio="none"')
  expect(drawBar(0.5, 'dim', 428, 'x').svg).toContain('preserveAspectRatio="none"')
  const bar = drawBar(0.25, 'dim', 428, 'Weekly 25% used')
  expect(bar.svg).toContain('<rect x="12" y="0" width="404" height="4" rx="2" class="k-track"')
  expect(bar.svg).toContain('width="101" height="4" rx="2" class="k-dim"')
  expect(drawBar(0, 'dim', 428, 'x').svg).not.toContain('k-dim"')
})

test('section label (Figma 1:1194): 20 top, 4 bottom, sized to its text', () => {
  const g = drawGroup({ label: 'Working', n: 1 })
  expect(g.alt).toBe('Working, 1 session')
  expect(Math.abs(g.height - 38.85)).toBeLessThan(0.1)
  // the label text starts 20 below the top of its row
  expect(g.svg).toContain('y="30.7"')
  expect(g.svg).not.toContain('height="1" class="k-rule"')
  expect(drawGroup({ label: 'Cold', n: 7 }).alt).toBe('Cold, 7 sessions')
})

test('rows carry no rule of their own; details and footer pictures', () => {
  expect(drawRow({ row: row(), now: NOW, width: 300, note: null }).svg).not.toContain('height="1" class="k-rule"')
  const det = drawDetails({ items: detailItems(row(), null, NOW), width: 280 })
  expect(det.svg).toContain('Last update')
  expect(det.svg).toContain('41 min left')
  const foot = footerLines({ headless: 0, agoMs: 4000 })
  expect(foot.left.svg).toContain('0 background runs in the last 6 hours')
  expect(foot.right.svg).toContain('Updated 4s ago')
  expect(foot.right.alt).toBe('Updated 4s ago')
  expect(foot.left.alt).toBe('0 background runs in the last 6 hours. Updated 4s ago.')
})

test('terminal bars are plain ASCII', () => {
  expect(textBar(0.06, 10)).toBe('[#.........]')
  expect(textBar(1, 10)).toBe('[##########]')
  expect(textBar(0, 4)).toBe('[....]')
})

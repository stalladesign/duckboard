// Pure: the pictures (SVG strings) and the plain-text parts both surfaces draw.
// Sizes, padding, rules and colors are design/mockup.html's tokens.
import type { GitFact, Group, Limit, Row } from '../types'
import { CACHE_TTL_MS } from './board'
import { cacheLabel, contextLine, fmtDur, fmtTokens, metaContext, resetsIn } from './format'

export const SPEC = { padX: 12, padY: 10, gap: 4, fsTitle: 13, fsBody: 12, fsMeta: 11, fsCount: 13, lh: 1.35, dot: 8, barH: 4, cacheBarW: 36, rule: 1 }

export const PALETTE = {
  light: { bg: '#ffffff', text: '#1f1f1f', dim: '#6b6b6b', rule: '#e6e6e6', track: '#ececec', hover: '#f5f5f5', working: '#2f6fdf', yourturn: '#2e9e5b', cold: '#9a9a9a', amber: '#b87d00', red: '#c4453b' },
  dark: { bg: '#1e1e1e', text: '#e8e8e8', dim: '#9a9a9a', rule: '#333333', track: '#3a3a3a', hover: '#262626', working: '#5b9cff', yourturn: '#4cc27c', cold: '#777777', amber: '#e0a526', red: '#e5675c' },
}
export type Theme = keyof typeof PALETTE
type Ink = Exclude<keyof typeof PALETTE.light, 'bg' | 'hover'>
const INKS: Ink[] = ['text', 'dim', 'rule', 'track', 'working', 'yourturn', 'cold', 'amber', 'red']
// The host draws the pictures as images, so the module cannot know its theme: each mark carries the light
// color and a class, and the SVG's own media query repaints it dark wherever the embedding page is dark.
const ink = (k: Ink) => ` class="k-${k}" fill="${PALETTE.light[k]}"`
const DARK_CSS = `<style>@media (prefers-color-scheme: dark){${INKS.map(k => `.k-${k}{fill:${PALETTE.dark[k]}}`).join('')}}</style>`
// A translucent gray reads as a light wash on either theme.
export const HOVER = '#8080801a'
export type Tone = 'text' | 'dim' | 'amber' | 'red' | 'ok'
export type Pic = { svg: string; alt: string; height: number }

export const GROUP_LABEL: Record<Group, string> = { working: 'Working', yourturn: 'Your turn', cold: 'Cold' }
const FONT = 'system-ui, -apple-system, Segoe UI, sans-serif'
const MIN = 60_000
const LOW_CACHE_MS = 10 * MIN
const TEXT_X = SPEC.padX + SPEC.dot + 8

// shortcut: per-glyph width classes for a system sans, not real metrics; widened 4% so text never overflows.
export function textWidth(s: string, size: number, bold = false): number {
  let em = 0
  for (const c of s) {
    if (" .,:;'!|ijl".includes(c)) em += 0.28
    else if ('frtI()[]-'.includes(c)) em += 0.38
    else if ('mw'.includes(c)) em += 0.85
    else if ('MW@'.includes(c)) em += 0.92
    else if (c >= '0' && c <= '9') em += 0.58
    else if (c >= 'A' && c <= 'Z') em += 0.66
    else if (c >= 'a' && c <= 'z') em += 0.54
    else em += 0.62
  }
  return em * size * (bold ? 1.06 : 1) * 1.04
}

export function fit(s: string, maxPx: number, size: number, bold = false): string {
  if (textWidth(s, size, bold) <= maxPx) return s
  const chars = [...s]
  while (chars.length && textWidth(chars.join('').trimEnd() + '...', size, bold) > maxPx) chars.pop()
  return chars.length ? chars.join('').trimEnd() + '...' : ''
}

export function wrap(s: string, maxPx: number, size: number, maxLines: number): string[] {
  const out: string[] = []
  let cur = ''
  const words = s.split(/\s+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    const next = cur ? cur + ' ' + words[i] : words[i]!
    if (textWidth(next, size) <= maxPx || !cur) {
      cur = next
      continue
    }
    out.push(cur)
    cur = words[i]!
    if (out.length === maxLines - 1) {
      out.push(fit(words.slice(i).join(' '), maxPx, size))
      return out
    }
  }
  if (cur) out.push(fit(cur, maxPx, size))
  return out.slice(0, maxLines)
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const r1 = (n: number) => Math.round(n * 10) / 10
const lineH = (size: number) => size * SPEC.lh
const baseline = (top: number, size: number) => r1(top + (lineH(size) - size) / 2 + size * 0.8)

const toneInk = (tone: Tone): Ink => (tone === 'ok' ? 'yourturn' : tone)

function text(x: number, y: number, s: string, size: number, fill: Ink, o: { bold?: boolean; anchor?: 'end' } = {}): string {
  return `<text x="${r1(x)}" y="${y}" font-size="${size}"${o.bold ? ' font-weight="600"' : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${ink(fill)}>${esc(s)}</text>`
}

function bar(x: number, y: number, w: number, pct: number, fill: Ink): string {
  const p = Math.max(0, Math.min(1, pct))
  return `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${SPEC.barH}" rx="2"${ink('track')}/>` +
    (p > 0 ? `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(Math.max(2, w * p))}" height="${SPEC.barH}" rx="2"${ink(fill)}/>` : '')
}

// `stretch` lets the desktop scale the picture across to the column's real width (given an Svg with a height
// only): the engine reports the width in cells, not pixels, so a drawing sized from them can fall up to a cell short.
const svg = (width: number, height: number, body: string, stretch = false) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${r1(height)}" viewBox="0 0 ${width} ${r1(height)}"${stretch ? ' preserveAspectRatio="none"' : ''} font-family="${FONT}">${DARK_CSS}${body}</svg>`

// Rules and bars are drawn at the caller's estimate of the width and stretched to the real one, so the estimate
// only has to be close (it keeps the bar's rounded ends round). Every picture says something: the desktop skips
// an Svg whose alt is empty, decorative or not.
export const drawRule = (width: number): Pic => ({ svg: svg(width, SPEC.rule, ruleLine(width, 0), true), alt: 'Divider', height: SPEC.rule })

// A limit's bar, inset by the text gutter on both sides of the width.
export function drawBar(pct: number, fill: Ink, width: number, alt: string): Pic {
  return { svg: svg(width, SPEC.barH, bar(SPEC.padX, 0, width - 2 * SPEC.padX, pct, fill), true), alt, height: SPEC.barH }
}

// Empty room of a fixed size: the side gutters beside a stretched bar, and vertical gaps.
export const drawSpace = (width: number, height: number): Pic => ({ svg: svg(width, height, ''), alt: 'Space', height })

// One line of text as a picture no wider than it, the line's top `top` below the picture's; `end` right-aligns
// it against the picture's right edge, less the gutter, for the right side of a row.
export function drawLine(o: { text: string; size: number; ink: Ink; top: number; bottom?: number; end?: boolean; bold?: boolean; alt?: string }): Pic & { width: number } {
  const w = Math.ceil(SPEC.padX + textWidth(o.text, o.size, o.bold) + 2)
  const h = r1(o.top + lineH(o.size) + (o.bottom ?? 0))
  const x = o.end ? w - SPEC.padX : SPEC.padX
  const body = text(x, baseline(o.top, o.size), o.text, o.size, o.ink, { bold: o.bold, anchor: o.end ? 'end' : undefined })
  return { svg: svg(w, h, body), alt: o.alt ?? o.text, height: h, width: w }
}

const ruleLine = (width: number, y: number) => `<rect x="0" y="${y}" width="${width}" height="${SPEC.rule}"${ink('rule')}/>`

export type MetaPart = { text: string; tone: Tone; bar: number | null }

export const cacheLeft = (row: Row, now: number) => (row.lastReplyAt === null ? null : CACHE_TTL_MS - (now - row.lastReplyAt))

// The meta line, shared by the picture and the terminal rows.
export function metaParts(row: Row, now: number): MetaPart[] {
  const parts: MetaPart[] = []
  const ctx = metaContext(row.tokens, row.window)
  if (row.group === 'cold') {
    if (row.idleSince !== null) parts.push({ text: `Idle ${fmtDur(now - row.idleSince)}`, tone: 'dim', bar: null })
  } else {
    const n = row.agentsRunning
    parts.push({ text: n === 0 ? 'No agents' : `${n} agent${n === 1 ? '' : 's'} running`, tone: 'dim', bar: null })
    const left = cacheLeft(row, now)
    const label = cacheLabel(left)
    if (label && left !== null) parts.push({ text: label, tone: left < LOW_CACHE_MS ? 'amber' : 'dim', bar: left / CACHE_TTL_MS })
    else parts.push({ text: `Cold: next turn rewrites ${row.tokens === null ? 'the context' : fmtTokens(row.tokens)}`, tone: 'amber', bar: null })
  }
  if (ctx) parts.push({ text: ctx, tone: 'dim', bar: null })
  return parts
}

export type Note = { text: string; tone: Tone }

export function drawRow(o: { row: Row; now: number; width: number; note: Note | null }): Pic {
  const { row, now, width } = o
  const avail = width - TEXT_X - SPEC.padX
  let y = SPEC.padY
  let body = ''
  const dotY = r1(y + lineH(SPEC.fsTitle) / 2)
  body += `<circle cx="${SPEC.padX + SPEC.dot / 2}" cy="${dotY}" r="${SPEC.dot / 2}" ${ink(row.group)}/>`
  const tag = row.isThis ? 'this one' : ''
  const tagW = tag ? textWidth(tag, SPEC.fsMeta) + 6 : 0
  const title = fit(row.title, avail - tagW, SPEC.fsTitle, true)
  body += text(TEXT_X, baseline(y, SPEC.fsTitle), title, SPEC.fsTitle, 'text', { bold: true })
  if (tag) body += text(TEXT_X + textWidth(title, SPEC.fsTitle, true) + 6, baseline(y, SPEC.fsTitle), tag, SPEC.fsMeta, 'dim')
  y += lineH(SPEC.fsTitle) + SPEC.gap
  if (row.what) {
    body += text(TEXT_X, baseline(y, SPEC.fsBody), fit(row.what, avail, SPEC.fsBody), SPEC.fsBody, 'text')
    y += lineH(SPEC.fsBody) + SPEC.gap
  }
  const parts = metaParts(row, now)
  let x = TEXT_X
  const by = baseline(y, SPEC.fsMeta)
  parts.forEach((part, i) => {
    if (i > 0) {
      body += text(x + 8, by, '|', SPEC.fsMeta, 'rule')
      x += 8 + textWidth('|', SPEC.fsMeta) + 8
    }
    if (part.bar !== null) {
      body += bar(x, y + (lineH(SPEC.fsMeta) - SPEC.barH) / 2, SPEC.cacheBarW, part.bar, part.tone === 'amber' ? 'amber' : 'yourturn')
      x += SPEC.cacheBarW + 8
    }
    const t = fit(part.text, Math.max(0, TEXT_X + avail - x), SPEC.fsMeta)
    body += text(x, by, t, SPEC.fsMeta, toneInk(part.tone))
    x += textWidth(t, SPEC.fsMeta)
  })
  y += lineH(SPEC.fsMeta)
  if (o.note) {
    y += SPEC.gap
    for (const l of wrap(o.note.text, avail, SPEC.fsMeta, 2)) {
      body += text(TEXT_X, baseline(y, SPEC.fsMeta), l, SPEC.fsMeta, toneInk(o.note.tone))
      y += lineH(SPEC.fsMeta)
    }
  }
  y += SPEC.padY
  const alt = [GROUP_LABEL[row.group] + '.', row.title + (row.isThis ? ' (this one).' : '.'), row.what ?? '', parts.map(x => x.text).join('. ') + '.', o.note?.text ?? '']
    .filter(Boolean)
    .join(' ')
  return { svg: svg(width, y, body), alt, height: y }
}

// Figma 1:1194 (Section Label): 20 top, 4 bottom; the 1px rule under it is drawRule's, so it spans the column.
const LABEL_TOP = 20

export function drawGroup(o: { label: string; n: number }): Pic & { width: number } {
  const h = r1(LABEL_TOP + lineH(SPEC.fsMeta) + 4)
  const by = baseline(LABEL_TOP, SPEC.fsMeta)
  const w = Math.ceil(SPEC.padX + textWidth(o.label, SPEC.fsMeta, true) + 4 + textWidth(String(o.n), SPEC.fsMeta) + 2)
  const body = text(SPEC.padX, by, o.label, SPEC.fsMeta, 'dim', { bold: true }) +
    text(SPEC.padX + textWidth(o.label, SPEC.fsMeta, true) + 4, by, String(o.n), SPEC.fsMeta, 'dim')
  return { svg: svg(w, h, body), alt: `${o.label}, ${o.n} session${o.n === 1 ? '' : 's'}`, height: h, width: w }
}

// Figma 1:721: the counts first (13px, numbers semibold), 12 below them, then each limit 8 apart, 24 at the bottom.
export const TOP = { countsH: SPEC.padY + 16, underCounts: 12, limitGap: 8, labelToBar: 3, bottom: 24 }

export function drawCounts(o: { counts: { working: number; yourturn: number; agents: number } }): Pic & { width: number } {
  const parts: [number, string][] = [[o.counts.working, 'working'], [o.counts.yourturn, 'your turn'], [o.counts.agents, `agent${o.counts.agents === 1 ? '' : 's'} running`]]
  const cy = r1(SPEC.padY + (16 - SPEC.fsCount) / 2 + SPEC.fsCount * 0.8)
  let x = SPEC.padX
  let body = ''
  parts.forEach(([n, label], i) => {
    if (i > 0) {
      body += text(x, cy, '|', SPEC.fsCount, 'rule')
      x += textWidth('|', SPEC.fsCount) + 10
    }
    body += text(x, cy, String(n), SPEC.fsCount, 'text', { bold: true })
    x += textWidth(String(n), SPEC.fsCount, true) + 6
    body += text(x, cy, label, SPEC.fsCount, 'text')
    x += textWidth(label, SPEC.fsCount) + 10
  })
  const w = Math.ceil(x)
  return { svg: svg(w, TOP.countsH, body), alt: parts.map(([n, label]) => `${n} ${label}`).join(', ') + '.', height: TOP.countsH, width: w }
}

// A limit's label row: its name and percent on the left, when it resets on the right.
export function limitLine(l: Limit, now: number, readAt?: number | null): { left: string; right: string | null; alt: string } {
  const left = `${l.label} ${l.percent}%`
  const resets = resetsIn(l.resetsAt, now)
  const right = resets && readAt != null ? `${resets}, read ${fmtDur(now - readAt)} ago` : resets
  return { left, right: right || null, alt: right ? `${left}, ${right}.` : `${left}.` }
}

export type DetailItem = { k: string; lines: string[]; bar: { pct: number; tone: Tone } | null }

export function detailItems(row: Row, git: GitFact | null, now: number): DetailItem[] {
  const items: DetailItem[] = []
  items.push({ k: 'Last update', lines: row.lastTwo.length ? row.lastTwo : ['unknown'], bar: null })
  items.push({ k: 'Context', lines: [contextLine(row.tokens, row.window)], bar: row.tokens !== null && row.window ? { pct: row.tokens / row.window, tone: 'dim' } : null })
  const left = cacheLeft(row, now)
  if (left !== null && left > 0) {
    items.push({ k: 'Cache', lines: [left < MIN ? 'Under 1 min left' : `${Math.floor(left / MIN)} min left`], bar: { pct: left / CACHE_TTL_MS, tone: left < LOW_CACHE_MS ? 'amber' : 'ok' } })
  } else {
    items.push({ k: 'Cache', lines: ['Cold. The next turn rewrites the context.'], bar: null })
  }
  const agents = row.agents.map(a => [a.name, a.model, a.startedAt === null ? null : fmtDur(now - a.startedAt)].filter(Boolean).join(', '))
  const done = row.agentsDoneHour
  if (agents.length || done) agents.push(`${done} agent${done === 1 ? '' : 's'} done in the last hour`)
  items.push({ k: 'Agents', lines: agents.length ? agents : ['No agents in the last hour'], bar: null })
  if (row.ticket) items.push({ k: 'Ticket', lines: [row.ticket], bar: null })
  if (git?.text) items.push({ k: 'Git', lines: [git.text], bar: null })
  if (row.test) {
    const t = row.test
    items.push({ k: 'Tests', lines: [t.kind === 'running' ? 'Testing' : t.kind === 'failed' ? 'Tests failed' : `Tested ${fmtDur(now - t.at)} ago`], bar: null })
  }
  return items
}

export function drawDetails(o: { items: DetailItem[]; width: number }): Pic {
  const kx = TEXT_X
  const vx = TEXT_X + 76 + 8
  const vw = o.width - vx - SPEC.padX
  let y = 0
  let body = ''
  for (const it of o.items) {
    body += text(kx, baseline(y, SPEC.fsBody), it.k, SPEC.fsMeta, 'dim')
    const lines = it.lines.flatMap(l => wrap(l, vw, SPEC.fsBody, it.k === 'Last update' ? 2 : 1))
    for (const l of lines) {
      body += text(vx, baseline(y, SPEC.fsBody), l, SPEC.fsBody, 'text')
      y += lineH(SPEC.fsBody)
    }
    if (it.bar) {
      body += bar(vx, y + 3, vw, it.bar.pct, toneInk(it.bar.tone))
      y += 3 + SPEC.barH
    }
    y += 6
  }
  y += SPEC.padY - 6
  const alt = o.items.map(i => `${i.k}: ${i.lines.join('; ')}.`).join(' ')
  return { svg: svg(o.width, y, body), alt, height: y }
}

// The footer's texts, each sized to itself; the rule above them and the room between are the pane's.
export function footerLines(o: { headless: number; agoMs: number }) {
  const left = `${o.headless} background run${o.headless === 1 ? '' : 's'} in the last 6 hours`
  const right = `Updated ${Math.max(0, Math.round(o.agoMs / 1000))}s ago`
  return {
    left: drawLine({ text: left, size: SPEC.fsMeta, ink: 'dim', top: 8, bottom: 8, alt: `${left}. ${right}.` }),
    right: drawLine({ text: right, size: SPEC.fsMeta, ink: 'dim', top: 8, bottom: 8, end: true }),
  }
}

export function textBar(pct: number, cells: number): string {
  const n = Math.max(0, Math.min(cells, Math.round(pct * cells)))
  return '[' + '#'.repeat(n) + '.'.repeat(cells - n) + ']'
}

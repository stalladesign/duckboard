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

function color(theme: Theme, tone: Tone): string {
  const p = PALETTE[theme]
  return tone === 'ok' ? p.yourturn : tone === 'text' ? p.text : p[tone]
}

function text(x: number, y: number, s: string, size: number, fill: string, o: { bold?: boolean; anchor?: 'end' } = {}): string {
  return `<text x="${r1(x)}" y="${y}" font-size="${size}"${o.bold ? ' font-weight="600"' : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''} fill="${fill}">${esc(s)}</text>`
}

function bar(x: number, y: number, w: number, pct: number, fill: string, track: string): string {
  const p = Math.max(0, Math.min(1, pct))
  return `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${SPEC.barH}" rx="2" fill="${track}"/>` +
    (p > 0 ? `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(Math.max(2, w * p))}" height="${SPEC.barH}" rx="2" fill="${fill}"/>` : '')
}

const svg = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${r1(height)}" viewBox="0 0 ${width} ${r1(height)}" font-family="${FONT}">${body}</svg>`

export const drawRule = (width: number, theme: Theme): Pic => ({ svg: svg(width, 1, ruleLine(width, 0, theme)), alt: '', height: 1 })

const ruleLine = (width: number, y: number, theme: Theme) => `<rect x="0" y="${y}" width="${width}" height="${SPEC.rule}" fill="${PALETTE[theme].rule}"/>`

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

export function drawRow(o: { row: Row; now: number; width: number; theme: Theme; note: Note | null }): Pic {
  const { row, now, width, theme } = o
  const p = PALETTE[theme]
  const avail = width - TEXT_X - SPEC.padX
  let y = SPEC.padY
  let body = ''
  const dotY = r1(y + lineH(SPEC.fsTitle) / 2)
  body += `<circle cx="${SPEC.padX + SPEC.dot / 2}" cy="${dotY}" r="${SPEC.dot / 2}" fill="${p[row.group]}"/>`
  const tag = row.isThis ? 'this one' : ''
  const tagW = tag ? textWidth(tag, SPEC.fsMeta) + 6 : 0
  const title = fit(row.title, avail - tagW, SPEC.fsTitle, true)
  body += text(TEXT_X, baseline(y, SPEC.fsTitle), title, SPEC.fsTitle, p.text, { bold: true })
  if (tag) body += text(TEXT_X + textWidth(title, SPEC.fsTitle, true) + 6, baseline(y, SPEC.fsTitle), tag, SPEC.fsMeta, p.dim)
  y += lineH(SPEC.fsTitle) + SPEC.gap
  if (row.what) {
    body += text(TEXT_X, baseline(y, SPEC.fsBody), fit(row.what, avail, SPEC.fsBody), SPEC.fsBody, p.text)
    y += lineH(SPEC.fsBody) + SPEC.gap
  }
  const parts = metaParts(row, now)
  let x = TEXT_X
  const by = baseline(y, SPEC.fsMeta)
  parts.forEach((part, i) => {
    if (i > 0) {
      body += text(x + 8, by, '|', SPEC.fsMeta, p.rule)
      x += 8 + textWidth('|', SPEC.fsMeta) + 8
    }
    if (part.bar !== null) {
      body += bar(x, y + (lineH(SPEC.fsMeta) - SPEC.barH) / 2, SPEC.cacheBarW, part.bar, part.tone === 'amber' ? p.amber : p.yourturn, p.track)
      x += SPEC.cacheBarW + 8
    }
    const t = fit(part.text, Math.max(0, TEXT_X + avail - x), SPEC.fsMeta)
    body += text(x, by, t, SPEC.fsMeta, color(theme, part.tone))
    x += textWidth(t, SPEC.fsMeta)
  })
  y += lineH(SPEC.fsMeta)
  if (o.note) {
    y += SPEC.gap
    for (const l of wrap(o.note.text, avail, SPEC.fsMeta, 2)) {
      body += text(TEXT_X, baseline(y, SPEC.fsMeta), l, SPEC.fsMeta, color(theme, o.note.tone))
      y += lineH(SPEC.fsMeta)
    }
  }
  y += SPEC.padY
  const alt = [GROUP_LABEL[row.group] + '.', row.title + (row.isThis ? ' (this one).' : '.'), row.what ?? '', parts.map(x => x.text).join('. ') + '.', o.note?.text ?? '']
    .filter(Boolean)
    .join(' ')
  return { svg: svg(width, y, body), alt, height: y }
}

// Figma 1:1194 (Section Label): 20 top, 4 bottom, a 1px rule along the bottom (drawn here, or beside a button by drawRule).
const LABEL_TOP = 20

export function drawGroup(o: { label: string; n: number; width: number; theme: Theme; rule: boolean }): Pic {
  const p = PALETTE[o.theme]
  const h = LABEL_TOP + lineH(SPEC.fsMeta) + 4 + (o.rule ? SPEC.rule : 0)
  const by = baseline(LABEL_TOP, SPEC.fsMeta)
  const body = text(SPEC.padX, by, o.label, SPEC.fsMeta, p.dim, { bold: true }) +
    text(SPEC.padX + textWidth(o.label, SPEC.fsMeta, true) + 4, by, String(o.n), SPEC.fsMeta, p.dim) +
    (o.rule ? ruleLine(o.width, r1(h - SPEC.rule), o.theme) : '')
  return { svg: svg(o.width, h, body), alt: `${o.label}, ${o.n} session${o.n === 1 ? '' : 's'}`, height: h }
}

// Figma 1:721: the counts first (13px, numbers semibold), 12 below them, then each limit 8 apart, 24 at the bottom.
export function drawTop(o: { limits: Limit[]; counts: { working: number; yourturn: number; agents: number }; now: number; width: number; theme: Theme; readAt?: number | null }): Pic {
  const p = PALETTE[o.theme]
  let y = SPEC.padY
  let body = ''
  const parts: [number, string][] = [[o.counts.working, 'working'], [o.counts.yourturn, 'your turn'], [o.counts.agents, `agent${o.counts.agents === 1 ? '' : 's'} running`]]
  const cy = r1(y + (16 - SPEC.fsCount) / 2 + SPEC.fsCount * 0.8)
  let x = SPEC.padX
  parts.forEach(([n, label], i) => {
    if (i > 0) {
      body += text(x, cy, '|', SPEC.fsCount, p.rule)
      x += textWidth('|', SPEC.fsCount) + 10
    }
    body += text(x, cy, String(n), SPEC.fsCount, p.text, { bold: true })
    x += textWidth(String(n), SPEC.fsCount, true) + 6
    body += text(x, cy, label, SPEC.fsCount, p.text)
    x += textWidth(label, SPEC.fsCount) + 10
  })
  y += 16 + (o.limits.length ? 12 : 0)
  const sum = parts.map(([n, label]) => `${n} ${label}`).join(', ')
  const alt: string[] = [sum + '.']
  for (const l of o.limits) {
    y += 8
    const left = `${l.label} ${l.percent}%`
    const resets = resetsIn(l.resetsAt, o.now)
    const right = resets && o.readAt != null ? `${resets}, read ${fmtDur(o.now - o.readAt)} ago` : resets
    body += text(SPEC.padX, baseline(y, SPEC.fsMeta), left, SPEC.fsMeta, p.text)
    if (right) body += text(o.width - SPEC.padX, baseline(y, SPEC.fsMeta), right, SPEC.fsMeta, p.dim, { anchor: 'end' })
    y += lineH(SPEC.fsMeta) + 3
    body += bar(SPEC.padX, y, o.width - 2 * SPEC.padX, l.percent / 100, p.dim, p.track)
    y += SPEC.barH
    alt.push(right ? `${left}, ${right}.` : `${left}.`)
  }
  y += 24
  return { svg: svg(o.width, y, body), alt: alt.join(' '), height: y }
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

export function drawDetails(o: { items: DetailItem[]; width: number; theme: Theme }): Pic {
  const p = PALETTE[o.theme]
  const kx = TEXT_X
  const vx = TEXT_X + 76 + 8
  const vw = o.width - vx - SPEC.padX
  let y = 0
  let body = ''
  for (const it of o.items) {
    body += text(kx, baseline(y, SPEC.fsBody), it.k, SPEC.fsMeta, p.dim)
    const lines = it.lines.flatMap(l => wrap(l, vw, SPEC.fsBody, it.k === 'Last update' ? 2 : 1))
    for (const l of lines) {
      body += text(vx, baseline(y, SPEC.fsBody), l, SPEC.fsBody, p.text)
      y += lineH(SPEC.fsBody)
    }
    if (it.bar) {
      body += bar(vx, y + 3, vw, it.bar.pct, color(o.theme, it.bar.tone), p.track)
      y += 3 + SPEC.barH
    }
    y += 6
  }
  y += SPEC.padY - 6
  const alt = o.items.map(i => `${i.k}: ${i.lines.join('; ')}.`).join(' ')
  return { svg: svg(o.width, y, body), alt, height: y }
}

export function drawFooter(o: { headless: number; agoMs: number; width: number; theme: Theme }): Pic {
  const p = PALETTE[o.theme]
  const left = `${o.headless} background run${o.headless === 1 ? '' : 's'} in the last 6 hours`
  const right = `Updated ${Math.max(0, Math.round(o.agoMs / 1000))}s ago`
  const h = 8 + lineH(SPEC.fsMeta) + 8
  const by = baseline(8, SPEC.fsMeta)
  const body = ruleLine(o.width, 0, o.theme) + text(SPEC.padX, by, fit(left, o.width - 2 * SPEC.padX - textWidth(right, SPEC.fsMeta) - 8, SPEC.fsMeta), SPEC.fsMeta, p.dim) +
    text(o.width - SPEC.padX, by, right, SPEC.fsMeta, p.dim, { anchor: 'end' })
  return { svg: svg(o.width, h, body), alt: `${left}. ${right}.`, height: h }
}

export function textBar(pct: number, cells: number): string {
  const n = Math.max(0, Math.min(cells, Math.round(pct * cells)))
  return '[' + '#'.repeat(n) + '.'.repeat(cells - n) + ']'
}

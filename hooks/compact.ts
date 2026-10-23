// Pure: the compact protocol lines and the state machine one row's compact moves through.
import type { CompactState, Row } from '../types'
import { CACHE_TTL_MS } from './board'
import type { Note } from './draw'
import { fmtTokens } from './format'

const SENT_MS = 30_000
const RUN_MS = 10 * 60_000
const DONE_MS = 10 * 60_000
const LOW_MS = 10 * 60_000

export type Line =
  | { kind: 'request'; id: string; from: string }
  | { kind: 'started'; id: string }
  | { kind: 'queued'; id: string }
  | { kind: 'result'; id: string; ok: true; before: number | null; after: number | null }
  | { kind: 'result'; id: string; ok: false; reason: string }

const ID = '[0-9a-f]{12}'
const SESSION = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const N = '(\\d+|unknown)'
const REQUEST = new RegExp(`^duckboard compact-request (${ID}) from (${SESSION})$`)
const STEP = new RegExp(`^duckboard compact-(started|queued) (${ID})$`)
const OK = new RegExp(`^duckboard compact-result (${ID}) ok ${N} ${N}$`)
const FAIL = new RegExp(`^duckboard compact-result (${ID}) fail ([^\\n]+)$`)

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const num = (s: string | undefined) => (s === undefined || s === 'unknown' ? null : Number(s))

export function formatLine(l: Line): string {
  if (l.kind === 'request') return `duckboard compact-request ${l.id} from ${l.from}`
  if (l.kind === 'started' || l.kind === 'queued') return `duckboard compact-${l.kind} ${l.id}`
  if (l.ok) return `duckboard compact-result ${l.id} ok ${l.before ?? 'unknown'} ${l.after ?? 'unknown'}`
  return `duckboard compact-result ${l.id} fail ${oneLine(l.reason) || 'no reason given'}`
}

export function parseLine(text: string): Line | null {
  let m = REQUEST.exec(text)
  if (m) return { kind: 'request', id: m[1]!, from: m[2]! }
  m = STEP.exec(text)
  if (m) return m[1] === 'started' ? { kind: 'started', id: m[2]! } : { kind: 'queued', id: m[2]! }
  m = OK.exec(text)
  if (m) return { kind: 'result', id: m[1]!, ok: true, before: num(m[2]), after: num(m[3]) }
  m = FAIL.exec(text)
  if (m) return { kind: 'result', id: m[1]!, ok: false, reason: m[2]! }
  return null
}

// A peer's message may come inside one envelope tag; the protocol line must be all that is inside.
export function unwrap(text: string): string {
  const t = text.trim()
  const m = /^<([a-zA-Z][\w-]*)(?:\s[^>]*)?>([\s\S]*)<\/\1>$/.exec(t)
  return m ? m[2]!.trim() : t
}

export function newId(bytes: Uint8Array): string {
  return [...bytes.slice(0, 6)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export const canCompact = (row: Row) => row.isLive && row.isIdle && row.group === 'yourturn'

export function request(prev: CompactState | null, id: string, now: number): CompactState {
  const ids = prev && (prev.kind === 'noanswer' || prev.kind === 'failed') ? [...new Set([...prev.ids, id])] : [id]
  return { kind: 'sent', ids, at: now, reason: null, before: null, after: null }
}

export function failed(prev: CompactState | null, reason: string, now: number): CompactState {
  return { kind: 'failed', ids: prev?.ids ?? [], at: now, reason, before: null, after: null }
}

export function onReply(s: CompactState | null, l: Line, now: number): CompactState | null {
  if (!s || l.kind === 'request' || !s.ids.includes(l.id)) return s
  if (l.kind === 'started') return { ...s, kind: 'compacting', at: now }
  if (l.kind === 'queued') return { ...s, kind: 'busy', at: now }
  if (l.ok) return { kind: 'done', ids: [], at: now, reason: null, before: l.before, after: l.after }
  return { ...s, kind: 'failed', at: now, reason: l.reason }
}

export function tick(s: CompactState | null, now: number): CompactState | null {
  if (!s) return s
  if (s.kind === 'sent' && now - s.at > SENT_MS) return { ...s, kind: 'noanswer', reason: 'No answer in 30 seconds.' }
  if ((s.kind === 'compacting' || s.kind === 'busy') && now - s.at > RUN_MS) return { ...s, kind: 'noanswer', reason: 'No result in 10 minutes.' }
  if (s.kind === 'done' && now - s.at > DONE_MS) return null
  return s
}

export function compactNote(s: CompactState | null, row: Row, now: number): Note | null {
  if (!s) {
    const left = row.lastReplyAt === null ? null : CACHE_TTL_MS - (now - row.lastReplyAt)
    if (canCompact(row) && left !== null && left > 0 && left < LOW_MS) return { text: `Cache ends in ${Math.max(1, Math.floor(left / 60_000))} min`, tone: 'amber' }
    return null
  }
  switch (s.kind) {
    case 'sent':
      return { text: 'Request sent. Waiting for the session to start it.', tone: 'dim' }
    case 'compacting':
      return { text: 'Compacting. Do not send this session a message.', tone: 'dim' }
    case 'busy':
      return { text: 'Busy. It compacts when this turn ends.', tone: 'dim' }
    case 'done': {
      // The after count: the engine's, else the next scan's reading once the session wrote again.
      const after = s.after ?? (row.lastReplyAt !== null && row.lastReplyAt > s.at ? row.tokens : null)
      const before = s.before === null ? 'unknown' : fmtTokens(s.before)
      return { text: `Compacted just now: ${before} to ${after === null ? 'unknown' : fmtTokens(after)} tokens. Cache is fresh.`, tone: 'ok' }
    }
    case 'noanswer':
      return { text: s.reason ?? 'No answer.', tone: 'red' }
    case 'failed':
      return { text: `Failed: ${s.reason ?? 'no reason given'}`, tone: 'red' }
  }
}

export function showButton(row: Row, s: CompactState | null): 'Compact' | 'Retry' | null {
  if (!canCompact(row)) return null
  if (!s || s.kind === 'done') return s ? null : 'Compact'
  return s.kind === 'noanswer' || s.kind === 'failed' ? 'Retry' : null
}

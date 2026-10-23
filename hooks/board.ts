// Pure: which sessions are on the board, in which group, with which facts.
import type { Agent, Group, Limit, Row } from '../types'
import { findTicket, firstPlainLine, plainLines, type Facts } from './transcript'

// Measured on this machine (2026-10-23): every cache write is the 1-hour tier
// (ephemeral_5m always 0); a 58.1 min gap still read 272,686 cached tokens, a
// 120.4 min gap rewrote 186,839. So the cache lifetime is 60 minutes.
export const CACHE_TTL_MS = 60 * 60_000

const MIN = 60_000
const HOUR = 60 * MIN
const RECENT_MS = 6 * HOUR
const OLD_MS = 7 * 24 * HOUR

export type RegEntry = {
  pid: number
  sessionId: string
  cwd: string | null
  kind: string | null
  entrypoint: string | null
  name: string | null
  nameSource: string | null
  status: string | null
  updatedAt: number
  statusUpdatedAt: number
  procStart: string | null
}

export type TFile = { sessionId: string; path: string; mtimeMs: number; size: number }

// `ps -o pid=,lstart=` lines, run with TZ=UTC to match the registry's procStart.
export function parsePs(stdout: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const l of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(l)
    if (m?.[1] && m[2]) out.set(Number(m[1]), m[2])
  }
  return out
}

const sameStart = (a: string, b: string) => a.replace(/\s+/g, ' ') === b.replace(/\s+/g, ' ')

// Live = the pid runs and is the same process that wrote the entry; newest entry per session wins.
export function liveSessions(entries: RegEntry[], ps: Map<number, string>): Map<string, RegEntry> {
  const out = new Map<string, RegEntry>()
  for (const r of entries) {
    const start = ps.get(r.pid)
    if (start === undefined) continue
    if (r.procStart && !sameStart(r.procStart, start)) continue
    const had = out.get(r.sessionId)
    if (!had || r.updatedAt > had.updatedAt) out.set(r.sessionId, r)
  }
  return out
}

export function pickFiles<F extends TFile>(files: F[], live: Set<string>, now: number): { recent: F[]; old: F[] } {
  const byNew = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)
  const liveFiles = byNew.filter(f => live.has(f.sessionId))
  const rest = byNew.filter(f => !live.has(f.sessionId))
  const recent = rest.filter(f => now - f.mtimeMs <= RECENT_MS).slice(0, 40)
  const old = rest.filter(f => now - f.mtimeMs > RECENT_MS && now - f.mtimeMs <= OLD_MS).slice(0, 60)
  return { recent: [...liveFiles, ...recent], old }
}

// shortcut: headless is read from the registry kind or an `sdk*` entrypoint; upgrade if the engine names more kinds.
export const isHeadless = (f: Facts, r: RegEntry | undefined) =>
  (r?.kind != null && r.kind !== 'interactive') || (f.entrypoint?.startsWith('sdk') ?? false)

export type AgentMeta = { description?: string; agentType?: string; model?: string } | null

export function toAgent(a: { id: string; mtimeMs: number; meta: AgentMeta; facts: Facts | null }, now: number): Agent {
  const recentWrite = now - a.mtimeMs < MIN
  const openCall = a.facts?.openToolAt != null && now - a.facts.openToolAt < HOUR
  return {
    id: a.id,
    name: a.meta?.description || a.meta?.agentType || a.id,
    model: a.meta?.model ?? a.facts?.model ?? null,
    startedAt: a.facts?.firstAt ?? null,
    isRunning: recentWrite || openCall,
    lastWriteAt: a.mtimeMs,
  }
}

const LIMIT_LABEL: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly' }

export function toLimits(rl: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): Limit[] {
  return rl.map(l => ({ label: LIMIT_LABEL[l.kind] ?? l.kind, percent: l.percentUsed, resetsAt: l.resetsAt ?? null }))
}

export type LimitsReading = { limits: Limit[]; at: number }

// This session's reading when it has one (and save it); else the last saved one, each window only until it resets.
export function pickLimits(fresh: Limit[], stored: unknown, now: number): { limits: Limit[]; readAt: number | null; save: LimitsReading | null } {
  if (fresh.length) return { limits: fresh, readAt: null, save: { limits: fresh, at: now } }
  const s = stored as Partial<LimitsReading> | null
  if (!s || typeof s !== 'object' || !Array.isArray(s.limits) || typeof s.at !== 'number') return { limits: [], readAt: null, save: null }
  const live = s.limits.filter(
    (l): l is Limit => typeof l?.label === 'string' && typeof l.percent === 'number' && typeof l.resetsAt === 'string' && Date.parse(l.resetsAt) > now,
  )
  return { limits: live, readAt: live.length ? s.at : null, save: null }
}

const basename = (p: string | null) => (p ? p.split(/[\\/]/).filter(Boolean).pop() ?? null : null)

export type BuildInput = {
  now: number
  thisId: string
  live: Map<string, RegEntry>
  addressName: string
  thisUsage: { tokens: number | null; window: number | null } | null
  sessions: { facts: Facts; agents: Agent[]; commit?: string | null }[]
}

const ORDER: Record<Group, number> = { working: 0, yourturn: 1, cold: 2 }

export function buildRows(input: BuildInput): { rows: Row[]; headless6h: number } {
  const { now, thisId, live, addressName, thisUsage } = input
  const rows: Row[] = []
  let headless6h = 0
  for (const { facts: f, agents, commit } of input.sessions) {
    const sid = f.sessionId
    if (!sid) continue
    const r = live.get(sid)
    if (isHeadless(f, r)) {
      if (f.lastAt !== null && now - f.lastAt <= RECENT_MS) headless6h++
      continue
    }
    const isThis = sid === thisId
    const running = agents.filter(a => a.isRunning)
    const cacheLeft = f.lastReplyAt === null ? null : CACHE_TTL_MS - (now - f.lastReplyAt)
    const isWarm = cacheLeft !== null && cacheLeft > 0
    const isIdle = r?.status !== 'busy'
    // Idle, warm but the last row not Claude's (an interrupted turn) also waits on the person: Your turn.
    const group: Group = !r ? 'cold' : !isIdle || running.length > 0 ? 'working' : isWarm ? 'yourturn' : 'cold'
    const tokens = (isThis ? thisUsage?.tokens : null) ?? f.tokens
    const window =
      (isThis ? thisUsage?.window : null) ??
      (f.model?.endsWith('[1m]') || (tokens ?? 0) > 200_000 ? 1_000_000 : null)
    const text = f.lastText ?? ''
    rows.push({
      sessionId: sid,
      title: (r?.nameSource === 'user' && r.name) || f.title || basename(f.cwd ?? r?.cwd ?? null) || 'unknown',
      isThis,
      group,
      isLive: !!r,
      isIdle,
      cwd: f.cwd ?? r?.cwd ?? null,
      branch: f.branch,
      what: firstPlainLine(text, addressName),
      lastTwo: plainLines(text, addressName, 2),
      tokens,
      window,
      lastReplyAt: f.lastReplyAt,
      idleSince: r?.status === 'idle' && r.statusUpdatedAt ? r.statusUpdatedAt : f.lastAt,
      agents: running.slice(0, 5),
      agentsRunning: running.length,
      agentsDoneHour: agents.filter(a => !a.isRunning && now - a.lastWriteAt < HOUR).length,
      ticket: findTicket(f.branch, commit ?? null, f.prompts),
      test: f.test,
    })
  }
  rows.sort((a, b) => ORDER[a.group] - ORDER[b.group] || (b.idleSince ?? 0) - (a.idleSince ?? 0))
  return { rows, headless6h }
}

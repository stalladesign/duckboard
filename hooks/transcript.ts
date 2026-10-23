// Pure: reads a session transcript (.jsonl text) into the facts the board needs.
import type { TestFact } from '../types'

export type Facts = {
  sessionId: string | null
  title: string | null
  cwd: string | null
  branch: string | null
  entrypoint: string | null
  model: string | null
  tokens: number | null
  lastReplyAt: number | null
  firstAt: number | null
  lastAt: number | null
  lastText: string | null
  isLastClaudes: boolean
  openToolAt: number | null
  prompts: string[]
  test: TestFact | null
  testOutputPath: string | null
  badLines: number
}

type Block = { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }

const TEST_CMD = /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|\bvitest\b|\bjest\b|\bpytest\b|\bgo test\b|\bcargo test\b|\bplugin test\b|\bplaywright test\b/
const FAILED = /\b[1-9]\d* (?:fail|failed|failing|errors?)\b|^\s*FAIL\b|\bTests? failed\b/im
const PASSED = /\b\d+ pass(?:ed)?\b|\bAll tests passed\b|^ok\b/im
const BG_PATH = /Output is being written to: (\S+)/

const blockText = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (typeof b === 'string' ? b : (b as Block)?.text ?? '')).join('\n') : ''

export function testFromOutput(text: string): 'passed' | 'failed' | null {
  if (FAILED.test(text)) return 'failed'
  if (PASSED.test(text)) return 'passed'
  return null
}

export function parseTranscript(text: string): Facts {
  const f: Facts = {
    sessionId: null, title: null, cwd: null, branch: null, entrypoint: null, model: null, tokens: null,
    lastReplyAt: null, firstAt: null, lastAt: null, lastText: null, isLastClaudes: false, openToolAt: null, prompts: [],
    test: null, testOutputPath: null, badLines: 0,
  }
  const open = new Map<string, number>()
  let testId: string | null = null
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let d: Record<string, any>
    try {
      d = JSON.parse(raw)
    } catch {
      // A tail read starts mid-line, and a live file can end mid-line; count it and go on.
      f.badLines++
      continue
    }
    if (d.type === 'custom-title' && typeof d.customTitle === 'string') f.title = d.customTitle
    if (d.isSidechain) continue
    if (typeof d.sessionId === 'string') f.sessionId ??= d.sessionId
    if (typeof d.cwd === 'string') f.cwd = d.cwd
    if (typeof d.gitBranch === 'string') f.branch = d.gitBranch
    if (typeof d.entrypoint === 'string') f.entrypoint ??= d.entrypoint
    const at = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN
    if (!Number.isNaN(at)) {
      f.firstAt ??= at
      f.lastAt = at
    }
    const m = d.message
    if (!m || (d.type !== 'user' && d.type !== 'assistant')) continue
    const content: Block[] = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []

    if (d.type === 'assistant') {
      if (m.model === '<synthetic>') continue
      const u = m.usage
      if (u) {
        f.tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        if (!Number.isNaN(at)) f.lastReplyAt = at
      }
      if (typeof m.model === 'string') f.model = m.model
      let hasTool = false
      for (const b of content) {
        if (b.type === 'text' && b.text?.trim()) f.lastText = b.text
        if (b.type === 'tool_use' && b.id) {
          hasTool = true
          open.set(b.id, at)
          const cmd = typeof b.input?.command === 'string' ? b.input.command : ''
          if (b.name === 'Bash' && TEST_CMD.test(cmd)) {
            testId = b.id
            f.test = { kind: 'running', at }
            f.testOutputPath = null
          }
        }
      }
      f.isLastClaudes = !hasTool
      continue
    }

    // user row: a prompt or tool results
    const results = content.filter(b => b.type === 'tool_result')
    for (const r of results) {
      if (r.tool_use_id) open.delete(r.tool_use_id)
      if (r.tool_use_id && r.tool_use_id === testId) {
        const out = blockText(r.content)
        const bg = BG_PATH.exec(out)
        if (bg?.[1] && /running in background/i.test(out)) {
          f.testOutputPath = bg[1]
        } else {
          // The output's own verdict first: a later command in the same call can set the exit code.
          f.test = { kind: testFromOutput(out) ?? (r.is_error ? 'failed' : 'passed'), at }
        }
      }
    }
    if (results.length === 0 && !d.isMeta) {
      const t = blockText(m.content).trim()
      if (t && !t.startsWith('<')) {
        f.prompts.push(t)
        if (f.prompts.length > 20) f.prompts.shift()
        f.isLastClaudes = false
      }
    }
  }
  for (const at of open.values()) f.openToolAt = Math.max(f.openToolAt ?? 0, at)
  return f
}

const stripInline = (s: string) =>
  s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    .trim()

function dropAddress(s: string, name: string): string {
  if (!name) return s
  const lower = s.toLowerCase()
  const n = name.toLowerCase()
  if (lower.startsWith(n) && (s[n.length] === ',' || s[n.length] === ':')) return s.slice(n.length + 1).trim()
  return s
}

// The plain lines of a reply: fences, table rows and rules skipped, markdown stripped.
export function plainLines(text: string, addressName: string, max: number): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const t = raw.trim()
    if (!t || t.startsWith('```') || t.startsWith('|') || /^[-*_]{3,}$/.test(t)) continue
    const s = dropAddress(stripInline(t), addressName)
    if (s) out.push(s)
    if (out.length >= max) break
  }
  return out
}

export function firstPlainLine(text: string, addressName: string): string | null {
  return plainLines(text, addressName, 1)[0] ?? null
}

const NOT_TICKETS = /^(?:UTF|ISO|SHA|RFC|CVE|HTTP|TLS|SSL|MD|AES|ES|GPT|WCAG|PEP|ECMA|X)-/
const TICKET = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g
const BRANCH_TICKET = /(?:^|[/_-])([a-z][a-z0-9]{1,9}-\d{1,6})(?=$|[/_-])/i

function firstTicket(s: string): string | null {
  for (const m of s.matchAll(TICKET)) if (m[1] && !NOT_TICKETS.test(m[1])) return m[1]
  return null
}

// Branch name first, then the newest commit subject, then prompts newest first.
export function findTicket(branch: string | null, commit: string | null, prompts: string[]): string | null {
  const b = branch ? BRANCH_TICKET.exec(branch)?.[1]?.toUpperCase() : undefined
  if (b && !NOT_TICKETS.test(b)) return b
  const c = commit ? firstTicket(commit) : null
  if (c) return c
  for (const p of [...prompts].reverse()) {
    const t = firstTicket(p)
    if (t) return t
  }
  return null
}

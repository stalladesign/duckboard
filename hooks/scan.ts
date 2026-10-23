// Engine IO: reads the registry, transcripts, agents, usage and git through `$`.
import type { EngineInterface } from 'claude-code'

import type { Agent, Board, GitFact } from '../types'
import { buildRows, liveSessions, parsePs, pickFiles, pickLimits, toAgent, toLimits, type AgentMeta, type RegEntry, type TFile } from './board'
import { parseTranscript, testFromOutput, type Facts } from './transcript'

const WHOLE_MAX = 3.5 * 1024 * 1024
const MIN = 60_000
const HOUR = 60 * MIN

export function log($: EngineInterface, what: string, err: unknown) {
  $.ui.log(`duckboard: ${what}: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
}

// Module cache by file time; a hot reload empties it and the next scan fills it again.
const factsCache = new Map<string, { mtimeMs: number; size: number; facts: Facts }>()
const metaCache = new Map<string, AgentMeta>()

export async function home($: EngineInterface): Promise<{ dir: string; isWindows: boolean }> {
  const h = await $.env.get('HOME')
  if (h) return { dir: h, isWindows: false }
  const u = await $.env.get('USERPROFILE')
  if (u) return { dir: u, isWindows: true }
  throw new Error('neither HOME nor USERPROFILE is set')
}

async function readFacts($: EngineInterface, f: { path: string; mtimeMs: number; size: number }): Promise<Facts | null> {
  const hit = factsCache.get(f.path)
  if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) return hit.facts
  try {
    let text: string
    if (f.size <= WHOLE_MAX) {
      text = String(await $.fs.read(f.path))
    } else {
      // A live file grows between listing and reading, and $.fs.read rejects over 4 MiB: read its tail.
      const r = await $.process.run(['tail', '-n', '600', f.path])
      if (r.exitCode !== 0) throw new Error(`tail exited ${r.exitCode}: ${r.stderr.trim()}`)
      text = r.stdout
    }
    const facts = parseTranscript(text)
    factsCache.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, facts })
    return facts
  } catch (err) {
    log($, `read ${f.path}`, err)
    return null
  }
}

async function readRegistry($: EngineInterface, dir: string): Promise<RegEntry[]> {
  const out: RegEntry[] = []
  let names: string[] = []
  try {
    names = (await $.fs.list(dir)).filter(e => e.kind === 'file' && /^\d+\.json$/.test(e.name)).map(e => e.name)
  } catch (err) {
    log($, `list ${dir}`, err)
    return out
  }
  for (const n of names) {
    try {
      const d = JSON.parse(String(await $.fs.read(`${dir}/${n}`)))
      if (typeof d.pid !== 'number' || typeof d.sessionId !== 'string') continue
      const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null)
      out.push({
        pid: d.pid, sessionId: d.sessionId, cwd: s('cwd'), kind: s('kind'), entrypoint: s('entrypoint'), name: s('name'),
        nameSource: s('nameSource'), status: s('status'), updatedAt: Number(d.updatedAt) || 0, statusUpdatedAt: Number(d.statusUpdatedAt) || 0, procStart: s('procStart'),
      })
    } catch (err) {
      // An entry being rewritten reads as broken JSON; the next scan reads it again.
      log($, `registry ${n}`, err)
    }
  }
  return out
}

async function livePids($: EngineInterface, pids: number[], isWindows: boolean): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map()
  if (isWindows) {
    // shortcut: tasklist gives no start time, so a reused pid on Windows still reads as live.
    const r = await $.process.run(['tasklist', '/FO', 'CSV', '/NH'])
    const alive = new Set([...r.stdout.matchAll(/^"[^"]*","(\d+)"/gm)].map(m => Number(m[1])))
    return new Map(pids.filter(p => alive.has(p)).map(p => [p, '']))
  }
  // One ps call; exit 1 just means some pid is gone.
  const r = await $.process.run(['ps', '-o', 'pid=,lstart=', '-p', pids.join(',')], { env: { TZ: 'UTC' } })
  return parsePs(r.stdout)
}

async function listTranscripts($: EngineInterface, projects: string): Promise<(TFile & { dir: string })[]> {
  const out: (TFile & { dir: string })[] = []
  let dirs: string[] = []
  try {
    dirs = (await $.fs.list(projects)).filter(e => e.kind === 'dir').map(e => e.name)
  } catch (err) {
    log($, `list ${projects}`, err)
    return out
  }
  for (const d of dirs) {
    const dir = `${projects}/${d}`
    try {
      for (const e of await $.fs.list(dir)) {
        if (e.kind === 'file' && e.name.endsWith('.jsonl')) out.push({ sessionId: e.name.slice(0, -6), path: `${dir}/${e.name}`, mtimeMs: e.mtimeMs, size: e.size, dir })
      }
    } catch (err) {
      log($, `list ${dir}`, err)
    }
  }
  return out
}

async function readAgents($: EngineInterface, sessionDir: string, now: number): Promise<Agent[]> {
  const dir = `${sessionDir}/subagents`
  let entries: Awaited<ReturnType<EngineInterface['fs']['list']>> = []
  try {
    if (!(await $.fs.exists(dir))) return []
    entries = await $.fs.list(dir)
  } catch (err) {
    log($, `list ${dir}`, err)
    return []
  }
  const agents: Agent[] = []
  for (const e of entries) {
    const m = /^agent-(.+)\.jsonl$/.exec(e.name)
    if (!m?.[1] || e.kind !== 'file' || now - e.mtimeMs > HOUR) continue
    const metaPath = `${dir}/agent-${m[1]}.meta.json`
    if (!metaCache.has(metaPath)) {
      try {
        metaCache.set(metaPath, (await $.fs.exists(metaPath)) ? JSON.parse(String(await $.fs.read(metaPath))) : null)
      } catch (err) {
        log($, `meta ${metaPath}`, err)
        metaCache.set(metaPath, null)
      }
    }
    const facts = await readFacts($, { path: `${dir}/${e.name}`, mtimeMs: e.mtimeMs, size: e.size })
    agents.push(toAgent({ id: m[1], mtimeMs: e.mtimeMs, meta: metaCache.get(metaPath) ?? null, facts }, now))
  }
  return agents
}

// A background test run: its output file decides passed or failed once it stops growing.
async function settleTest($: EngineInterface, f: Facts, now: number): Promise<void> {
  if (f.test?.kind !== 'running' || !f.testOutputPath) return
  try {
    if (!(await $.fs.exists(f.testOutputPath))) return
    const st = await $.fs.stat(f.testOutputPath)
    const r = await $.process.run(['tail', '-n', '200', f.testOutputPath])
    const verdict = testFromOutput(r.stdout)
    if (verdict) f.test = { kind: verdict, at: st.mtimeMs }
    else if (now - st.mtimeMs > MIN) f.test = null
  } catch (err) {
    log($, `test output ${f.testOutputPath}`, err)
  }
}

export async function scan($: EngineInterface, opts: { addressName: string; commits: Record<string, string | null> }): Promise<Board> {
  const now = await $.clock.now()
  const { dir: h, isWindows } = await home($)
  const reg = await readRegistry($, `${h}/.claude/sessions`)
  let ps = new Map<number, string>()
  try {
    ps = await livePids($, [...new Set(reg.map(r => r.pid))], isWindows)
  } catch (err) {
    log($, 'process list', err)
  }
  const live = liveSessions(reg, ps)
  const files = await listTranscripts($, `${h}/.claude/projects`)
  const { recent, old } = pickFiles(files, new Set(live.keys()), now)
  const sessions: { facts: Facts; agents: Agent[]; commit?: string | null }[] = []
  for (const f of recent) {
    const facts = await readFacts($, f)
    if (!facts) continue
    facts.sessionId ??= f.sessionId
    await settleTest($, facts, now)
    const agents = await readAgents($, `${f.dir}/${f.sessionId}`, now)
    sessions.push({ facts, agents, commit: opts.commits[f.sessionId] ?? null })
  }
  // Old ones: read once, cached by file time, never scanned for agents.
  for (const f of old) {
    const facts = await readFacts($, f)
    if (!facts) continue
    facts.sessionId ??= f.sessionId
    sessions.push({ facts, agents: [] })
  }
  let thisUsage: { tokens: number | null; window: number | null } | null = null
  let limits: Board['limits'] = []
  let limitsReadAt: number | null = null
  try {
    const u = await $.session.usage()
    thisUsage = { tokens: u.context.tokens ?? null, window: u.context.window || null }
    limits = toLimits(u.rateLimits)
  } catch (err) {
    log($, 'session usage', err)
  }
  // A session that has sent no request yet has no reading: show the last real one any session saved.
  try {
    const picked = pickLimits(limits, await $.store.get('limits'), now)
    limits = picked.limits
    limitsReadAt = picked.readAt
    if (picked.save) await $.store.set('limits', picked.save)
  } catch (err) {
    log($, 'saved limits', err)
  }
  const thisId = await $.session.id()
  const { rows, headless6h } = buildRows({ now, thisId, live, addressName: opts.addressName, thisUsage, sessions })
  return { scannedAt: now, rows, headless6h, limits, limitsReadAt, error: null }
}

// Git facts for one folder: "Pushed" or "N not pushed", and the newest commit subject.
export async function gitFact($: EngineInterface, cwd: string, now: number): Promise<{ fact: GitFact; commit: string | null }> {
  let text: string | null = null
  let commit: string | null = null
  try {
    const r = await $.process.run(['git', '-C', cwd, 'rev-list', '--count', '@{u}..HEAD'], { timeoutMs: 10_000 })
    if (r.exitCode === 0) {
      const n = Number(r.stdout.trim())
      text = n === 0 ? 'Pushed' : `${n} not pushed`
    } else {
      log($, `git rev-list in ${cwd}`, r.stderr.trim() || `exit ${r.exitCode}`)
    }
    const c = await $.process.run(['git', '-C', cwd, 'log', '-1', '--format=%s'], { timeoutMs: 10_000 })
    if (c.exitCode === 0) commit = c.stdout.trim() || null
  } catch (err) {
    log($, `git in ${cwd}`, err)
  }
  return { fact: { text, at: now }, commit }
}

export async function readTheme($: EngineInterface): Promise<'light' | 'dark'> {
  try {
    const row = (await $.config.list()).find(r => r.key === 'theme')
    // shortcut: "auto" (follow the system) reads as light; the module cannot see the system theme.
    return typeof row?.value === 'string' && row.value.includes('dark') ? 'dark' : 'light'
  } catch (err) {
    log($, 'theme', err)
    return 'light'
  }
}

// Test helper: a fake home folder with three registry entries (two live) and four transcripts.
import type { On } from 'claude-code'

export const NOW = Date.parse('2026-01-01T12:00:00Z')
export const MIN = 60_000
export const A = 'aaaaaaaa-0000-4000-8000-000000000001' // live, idle, warm: Your turn
export const B = 'bbbbbbbb-0000-4000-8000-000000000002' // this session, busy
export const HOME = '/home/u'
const PROJ = `${HOME}/.claude/projects/-w-app`

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
// The kit's find matches a leaf's text, not an Svg's alt: walk the drawn tree for alts.
const alts = (n: unknown): string[] => {
  const x = n as Node
  return [...(x?.type === 'Svg' && typeof x.props?.alt === 'string' ? [x.props.alt] : []), ...((x?.children ?? []) as unknown[]).flatMap(alts)]
}
export const svgs = async (ui: { find: (q: { type: string }) => Promise<unknown> }) => alts(await ui.find({ type: 'Box' }))
export const hasSvg = async (ui: { find: (q: { type: string }) => Promise<unknown> }, m: string | RegExp) =>
  (await svgs(ui)).some(a => (typeof m === 'string' ? a === m : m.test(a)))

export const PANE = {
  plugin: 'duckboard',
  component: 'Pane',
  requestId: 'duckboard',
  props: { title: 'duckboard', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const at = (minAgo: number) => new Date(NOW - minAgo * MIN).toISOString()
const transcript = (sid: string, minAgo: number, text: string, cwd = '/w/app') =>
  [
    JSON.stringify({ type: 'user', timestamp: at(minAgo + 1), sessionId: sid, cwd, gitBranch: 'main', entrypoint: 'claude-desktop', message: { role: 'user', content: 'go' } }),
    JSON.stringify({ type: 'assistant', timestamp: at(minAgo), sessionId: sid, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_read_input_tokens: 182_000, cache_creation_input_tokens: 0 } } }),
  ].join('\n')

const FILES: Record<string, string> = {
  [`${HOME}/.claude/sessions/100.json`]: JSON.stringify({ pid: 100, sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', status: 'idle', kind: 'interactive', name: 'Login fix', nameSource: 'user', updatedAt: 1, statusUpdatedAt: NOW - 19 * MIN, procStart: 'Thu Jan  1 11:00:00 2026' }),
  [`${HOME}/.claude/sessions/101.json`]: JSON.stringify({ pid: 101, sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', status: 'busy', kind: 'interactive', name: 'Board work', nameSource: 'user', updatedAt: 1, statusUpdatedAt: NOW, procStart: 'Thu Jan  1 11:00:00 2026' }),
  [`${HOME}/.claude/sessions/102.json`]: JSON.stringify({ pid: 102, sessionId: 'dddddddd-0000-4000-8000-000000000004', status: 'idle', kind: 'interactive', name: 'Gone', nameSource: 'user', updatedAt: 1, statusUpdatedAt: 0, procStart: 'Thu Jan  1 11:00:00 2026' }),
  [`${PROJ}/aaaaaaaa-0000-4000-8000-000000000001.jsonl`]: transcript('aaaaaaaa-0000-4000-8000-000000000001', 19, 'Done. The tests pass.\nNext: deploy.'),
  [`${PROJ}/bbbbbbbb-0000-4000-8000-000000000002.jsonl`]: transcript('bbbbbbbb-0000-4000-8000-000000000002', 1, 'Working on the board.'),
  [`${PROJ}/cccccccc-0000-4000-8000-000000000003.jsonl`]: transcript('cccccccc-0000-4000-8000-000000000003', 300, 'Old work finished.', '/w/old-project'),
  [`${PROJ}/dddddddd-0000-4000-8000-000000000004.jsonl`]: transcript('dddddddd-0000-4000-8000-000000000004', 30, 'Its pid is dead.'),
}
const MTIME: Record<string, number> = { 'aaaaaaaa-0000-4000-8000-000000000001': NOW - 19 * MIN, 'bbbbbbbb-0000-4000-8000-000000000002': NOW - MIN, 'cccccccc-0000-4000-8000-000000000003': NOW - 300 * MIN, 'dddddddd-0000-4000-8000-000000000004': NOW - 30 * MIN }

// rateLimits: what the session's last API response carried; [] for a session that has sent none yet.
export function engine(on: On, seen: { reads: string[]; argv: string[][] }, withOpen = true, files: Record<string, string> = {}, rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[]) {
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.list', (_$, e) => {
    const file = (name: string, mtimeMs = 0) => ({ name, kind: 'file' as const, size: 100, mtimeMs, isLink: false })
    if (e.path === `${HOME}/.claude/sessions`) return { value: [file('100.json'), file('101.json'), file('102.json'), file('100.0123abcd.key')] }
    if (e.path === `${HOME}/.claude/projects`) return { value: [{ name: '-w-app', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }
    if (e.path === PROJ) return { value: Object.keys(MTIME).map(s => file(`${s}.jsonl`, MTIME[s])) }
    return { value: [] }
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_$, e) => {
    seen.reads.push(e.path)
    const text = files[e.path] ?? FILES[e.path]
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  on('process.run', (_$, e) => {
    seen.argv.push([...e.argv])
    if (e.argv[0] === 'ps') return { value: { exitCode: 1, stdout: '  100 Thu Jan  1 11:00:00 2026\n  101 Thu Jan  1 11:00:00 2026\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'git' && e.argv.includes('rev-list')) return { value: { exitCode: 0, stdout: '2\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: 'ABC-7 fix login\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 1, stdout: '', stderr: 'unexpected', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: { startedAt: NOW - 60 * MIN, context: { tokens: 127_000, window: 1_000_000, percent: 13 }, rateLimits: rateLimits ?? [{ kind: 'five_hour', percentUsed: 6, resetsAt: new Date(NOW + 250 * MIN).toISOString() }] } }))
  on('session.id', () => ({ value: 'bbbbbbbb-0000-4000-8000-000000000002' }))
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'enum', value: 'dark', provider: { kind: 'engine' } }] as never }))
  on('command.register', () => ({ value: { command: 'duckboard' } }))
  on('ui.log', () => ({ value: undefined }))
  if (withOpen) on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
}

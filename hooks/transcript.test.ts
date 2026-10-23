import { expect, test } from 'claude-code/testing'

import { parseTranscript, firstPlainLine, plainLines, findTicket, testFromOutput } from './transcript'

const T0 = Date.parse('2026-01-01T10:00:00Z')
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString()
const line = (o: object) => JSON.stringify(o)

const user = (min: number, text: string) =>
  line({ type: 'user', timestamp: iso(min), sessionId: 's1', cwd: '/w/app', gitBranch: 'feat/abc-12-x', entrypoint: 'claude-desktop', message: { role: 'user', content: text } })
const reply = (min: number, content: object[], usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90 }) =>
  line({ type: 'assistant', timestamp: iso(min), sessionId: 's1', message: { role: 'assistant', model: 'claude-opus-5-5', content, usage } })
const toolResult = (min: number, id: string, text: string, isError = false) =>
  line({ type: 'user', timestamp: iso(min), sessionId: 's1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } })

test('reads title, branch, tokens and the newest reply text', () => {
  const text = [
    line({ type: 'custom-title', customTitle: 'Old', sessionId: 's1' }),
    user(0, 'please fix it'),
    reply(1, [{ type: 'text', text: 'First answer.' }]),
    line({ type: 'custom-title', customTitle: 'Fix the login', sessionId: 's1' }),
    user(2, 'more'),
    reply(3, [{ type: 'text', text: '**Done.** See [the file](src/a.ts).\n\nSecond line here.' }]),
    reply(4, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], { input_tokens: 5, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 }),
    toolResult(4, 't1', 'a.ts'),
    reply(5, [{ type: 'text', text: '' }], { input_tokens: 1, cache_read_input_tokens: 2400, cache_creation_input_tokens: 0 }),
  ].join('\n')
  const f = parseTranscript(text)
  expect(f.sessionId).toBe('s1')
  expect(f.title).toBe('Fix the login')
  expect(f.branch).toBe('feat/abc-12-x')
  expect(f.cwd).toBe('/w/app')
  expect(f.entrypoint).toBe('claude-desktop')
  expect(f.tokens).toBe(2401)
  expect(f.model).toBe('claude-opus-5-5')
  expect(f.lastReplyAt).toBe(T0 + 5 * 60_000)
  // the empty block and the tool-only turn are skipped
  expect(f.lastText).toBe('**Done.** See [the file](src/a.ts).\n\nSecond line here.')
  expect(f.isLastClaudes).toBe(true)
})

test('a tool call still open means the last reply is not Claude', () => {
  const text = [user(0, 'go'), reply(1, [{ type: 'tool_use', id: 't9', name: 'Read', input: {} }])].join('\n')
  const f = parseTranscript(text)
  expect(f.isLastClaudes).toBe(false)
  expect(f.openToolAt).toBe(T0 + 60_000)
})

test('a synthetic message and a sidechain line do not count', () => {
  const text = [
    user(0, 'go'),
    reply(1, [{ type: 'text', text: 'real' }]),
    line({ type: 'assistant', timestamp: iso(2), isSidechain: true, message: { role: 'assistant', model: 'x', content: [{ type: 'text', text: 'side' }], usage: { input_tokens: 9 } } }),
    line({ type: 'assistant', timestamp: iso(3), message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }], usage: { input_tokens: 0 } } }),
  ].join('\n')
  const f = parseTranscript(text)
  expect(f.lastText).toBe('real')
  expect(f.tokens).toBe(1100)
})

test('a broken or cut first line is skipped, not fatal', () => {
  const text = ['{"type":"user","mess', reply(1, [{ type: 'text', text: 'ok' }])].join('\n')
  const f = parseTranscript(text)
  expect(f.lastText).toBe('ok')
  expect(f.badLines).toBe(1)
})

test('test runs: passed, failed, background', () => {
  const pass = [reply(1, [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'pnpm test' } }]), toolResult(2, 'a', '12 passed')].join('\n')
  expect(parseTranscript(pass).test).toEqual({ kind: 'passed', at: T0 + 2 * 60_000 })
  const fail = [reply(1, [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npx vitest run' } }]), toolResult(2, 'b', 'Tests: 2 failed', true)].join('\n')
  expect(parseTranscript(fail).test).toEqual({ kind: 'failed', at: T0 + 2 * 60_000 })
  const open = reply(1, [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'pytest -q' } }])
  expect(parseTranscript(open).test).toEqual({ kind: 'running', at: T0 + 60_000 })
  const bg = [reply(1, [{ type: 'tool_use', id: 'd', name: 'Bash', input: { command: 'pnpm test', run_in_background: true } }]), toolResult(1, 'd', 'Command running in background with ID: x1. Output is being written to: /tmp/x1.output')].join('\n')
  const f = parseTranscript(bg)
  expect(f.test).toEqual({ kind: 'running', at: T0 + 60_000 })
  expect(f.testOutputPath).toBe('/tmp/x1.output')
  const notTest = [reply(1, [{ type: 'tool_use', id: 'e', name: 'Bash', input: { command: 'git status' } }]), toolResult(2, 'e', 'clean')].join('\n')
  expect(parseTranscript(notTest).test).toBe(null)
})

test('background test output is read for its verdict', () => {
  expect(testFromOutput('ok\n 3 failed, 9 passed')).toBe('failed')
  expect(testFromOutput('Tests  9 passed (9)')).toBe('passed')
  expect(testFromOutput('still compiling')).toBe(null)
  expect(testFromOutput(' 18 pass\n 0 fail\nRan 18 tests')).toBe('passed')
  expect(testFromOutput(' 17 pass\n 1 fail')).toBe('failed')
})

test('the output verdict wins over a non-zero exit from a later command', () => {
  const t = [reply(1, [{ type: 'tool_use', id: 'z', name: 'Bash', input: { command: 'claude plugin test . | tail -3; which bun' } }]), toolResult(2, 'z', ' 18 pass\n 0 fail\nbun not found', true)].join('\n')
  expect(parseTranscript(t).test?.kind).toBe('passed')
})

test('first plain line: markdown stripped, address name dropped', () => {
  expect(firstPlainLine('```ts\ncode\n```\n## Heading **bold**\nnext', '')).toBe('code')
  expect(firstPlainLine('\n\n- The [worker](#local_1) finished `abc1234`.', '')).toBe('The worker finished abc1234.')
  expect(firstPlainLine('Sam, the build passed.', 'Sam')).toBe('the build passed.')
  expect(firstPlainLine('sam: done', 'Sam')).toBe('done')
  expect(firstPlainLine('Samwise things', 'Sam')).toBe('Samwise things')
  expect(firstPlainLine('| a | b |\n|---|---|\nAfter table', '')).toBe('After table')
  expect(firstPlainLine('', '')).toBe(null)
  expect(plainLines('One.\n\nTwo.\nThree.', '', 2)).toEqual(['One.', 'Two.'])
})

test('ticket ids: branch, then commit, then prompts; no false hits', () => {
  expect(findTicket('feat/abc-12-login', null, [])).toBe('ABC-12')
  expect(findTicket('claude/quiet-otter-74d78b', 'WEB-9 fix nav', [])).toBe('WEB-9')
  expect(findTicket('main', 'Use UTF-8 and SHA-256', ['see JIRA-77 please'])).toBe('JIRA-77')
  expect(findTicket('main', null, ['ISO-8601 dates'])).toBe(null)
})

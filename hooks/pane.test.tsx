import { expect, mock, test } from 'claude-code/testing'

import { engine, hasSvg, MIN, NOW, PANE, svgs } from './fixture'

test('the board groups real registry and transcript data, on every surface', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = { reads: [] as string[], argv: [] as string[][] }
  engine(on, seen)
  await $.session.start({ cwd: '/w/app', surface: 'desktop', isInteractive: true })
  await clock.settle()

  // never a credential file, and one ps call with UTC start times
  expect(seen.reads.some(p => p.endsWith('.key'))).toBe(false)
  expect(seen.argv.filter(a => a[0] === 'ps')).toEqual([['ps', '-o', 'pid=,lstart=', '-p', '100,101,102']])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await hasSvg(ui, /5-hour limit 6%, resets in 4h 10m/)).toBe(true)
  expect(await hasSvg(ui, /1 working, 1 your turn, 0 agents running/)).toBe(true)
  expect(await hasSvg(ui, /^Working\. Board work \(this one\)\..*13%/)).toBe(true)
  expect(await hasSvg(ui, /^Your turn\. Login fix\. Done\. The tests pass\. No agents\. Cache 41m\. 182k tokens\./)).toBe(true)
  // under 200k with no [1m] in the model name: the window is unknown, so no percent
  // closed (no registry entry) and dead pid are both Cold, folded by default
  expect(await hasSvg(ui, 'Cold, 2 sessions')).toBe(true)
  expect(await hasSvg(ui, /Old work finished/)).toBe(false)
  expect((await ui.find({ key: 'cold-toggle' }))?.text).toBe('Show')

  await ui.press({ key: 'cold-toggle' })
  expect((await ui.find({ key: 'cold-toggle' }))?.text).toBe('Hide')
  expect(await hasSvg(ui, /^Cold\. old-project\. Old work finished\. Idle 5h\. 182k tokens\./)).toBe(true)
  expect(await hasSvg(ui, /^Cold\. Gone\./)).toBe(false) // a dead pid's name is not a name I set on a live session
  await ui.press({ key: 'cold-toggle' })
  expect(await hasSvg(ui, /Old work finished/)).toBe(false)

  await ui.press({ key: 'd-aaaaaaaa-0000-4000-8000-000000000001' })
  expect((await ui.find({ key: 'd-aaaaaaaa-0000-4000-8000-000000000001' }))?.text).toBe('Hide details')
  const det = (await svgs(ui)).find(a => a.startsWith('Last update: Done. The tests pass.; Next: deploy.'))
  expect(det).toContain('Context: 182k tokens.')
  expect(det).toContain('Cache: 41 min left.')
  expect(det).toContain('Git: 2 not pushed.')
  expect(seen.argv.some(a => a.join(' ') === 'git -C /w/app rev-list --count @{u}..HEAD')).toBe(true)
  await ui.press({ key: 'd-aaaaaaaa-0000-4000-8000-000000000001' })
  expect(await hasSvg(ui, /^Last update/)).toBe(false)
  await ui.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /^5-hour limit 6% \[#\.{9}\] resets in 4h 10m$/ }))).toBeDefined()
  expect((await term.find({ type: 'Text', text: 'Your turn 1' }))).toBeDefined()
  expect((await term.find({ type: 'Text', text: /No agents \| Cache 41m \[#{7}\.{3}\] \| 182k tokens/ }))).toBeDefined()
  expect((await term.find({ type: 'Text', text: /0 background runs in the last 6 hours/ }))).toBeDefined()
  await term.unmount()
})

test('the timer rescans every 20 seconds', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const seen = { reads: [] as string[], argv: [] as string[][] }
  engine(on, seen)
  await $.session.start({ cwd: '/w/app', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ps = () => seen.argv.filter(a => a[0] === 'ps').length
  expect(ps()).toBe(1)
  await clock.advance(20_000)
  expect(ps()).toBe(2)
})

test('/duckboard opens the pane', async ($, on) => {
  mock.clock(on, { now: NOW })
  engine(on, { reads: [], argv: [] }, false)
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  await $.session.start({ cwd: '/w/app', surface: 'desktop', isInteractive: true })
  expect(opened).toEqual(['duckboard'])
  // The kit fills origin and presentation as a person's typed command; the test names only the command.
  const r = await $.command.run({ command: 'duckboard', args: '' } as Parameters<typeof $.command.run>[0])
  expect(r.text).toBe('duckboard opened.')
  expect(opened).toEqual(['duckboard', 'duckboard'])
})

test('a new session with no reading yet shows the last real limits from the store', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { limits: { limits: [{ label: '5-hour limit', percent: 32, resetsAt: new Date(NOW + 179 * MIN).toISOString() }], at: NOW - 12 * MIN } })
  engine(on, { reads: [], argv: [] }, true, {}, [])
  await $.session.start({ cwd: '/w/app', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await hasSvg(ui, /5-hour limit 32%, resets in 2h 59m, read 12m ago\./)).toBe(true)
  await ui.unmount()
})

test('a fresh reading is saved for the next session', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: { key: string; value: unknown }[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_$, e) => {
    saved.push({ key: e.key, value: e.value })
    return { value: undefined }
  })
  engine(on, { reads: [], argv: [] })
  await $.session.start({ cwd: '/w/app', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(saved).toEqual([{ key: 'limits', value: { limits: [{ label: '5-hour limit', percent: 6, resetsAt: new Date(NOW + 250 * MIN).toISOString() }], at: NOW } }])
})

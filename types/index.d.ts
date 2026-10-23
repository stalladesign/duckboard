export type Group = 'working' | 'yourturn' | 'cold'

export type Agent = {
  id: string
  name: string
  model: string | null
  startedAt: number | null
  isRunning: boolean
  lastWriteAt: number
}

export type TestFact = { kind: 'passed' | 'failed' | 'running'; at: number }

export type Row = {
  sessionId: string
  title: string
  isThis: boolean
  group: Group
  isLive: boolean
  isIdle: boolean
  cwd: string | null
  branch: string | null
  what: string | null
  lastTwo: string[]
  tokens: number | null
  window: number | null
  lastReplyAt: number | null
  idleSince: number | null
  agents: Agent[]
  agentsRunning: number
  agentsDoneHour: number
  ticket: string | null
  test: TestFact | null
}

export type Limit = { label: string; percent: number; resetsAt: string | null }

export type Board = {
  scannedAt: number
  rows: Row[]
  headless6h: number
  limits: Limit[]
  // When the limits were read, if not by this session's own last response; null when they are this session's.
  limitsReadAt: number | null
  error: string | null
}

export type GitFact = { text: string | null; at: number }

export type CompactKind = 'sent' | 'compacting' | 'busy' | 'done' | 'noanswer' | 'failed'

export type CompactState = {
  kind: CompactKind
  ids: string[]
  at: number
  reason: string | null
  before: number | null
  after: number | null
}

// A request this session took and has not answered yet.
export type Pending = { id: string; from: string | null; at: number }

declare module 'claude-code' {
  interface PluginState {
    duckboard: {
      board: Board | null
      coldOpen: boolean
      openRows: string[]
      compact: Record<string, CompactState>
      theme: 'light' | 'dark'
      git: Record<string, GitFact>
      pending: Pending | null
      isTurnRunning: boolean
    }
  }
}

// Pure: the words and numbers the board shows.
const MIN = 60_000

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function fmtDur(ms: number): string {
  if (ms < MIN) return '<1m'
  const m = Math.floor(ms / MIN)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function cacheLabel(leftMs: number | null): string | null {
  if (leftMs === null || leftMs <= 0) return null
  return leftMs < MIN ? 'Cache <1m' : `Cache ${Math.floor(leftMs / MIN)}m`
}

export const percentOf = (tokens: number, window: number) => Math.round((tokens / window) * 100)

export function contextLine(tokens: number | null, window: number | null): string {
  if (tokens === null) return 'unknown'
  if (window === null) return `${fmtTokens(tokens)} tokens`
  return `${fmtTokens(tokens)} of ${fmtTokens(window)} tokens (${percentOf(tokens, window)}%)`
}

// The short form on the meta line: a percent when the window is known, else the count.
export function metaContext(tokens: number | null, window: number | null): string | null {
  if (tokens === null) return null
  return window === null ? `${fmtTokens(tokens)} tokens` : `${percentOf(tokens, window)}%`
}

export function resetsIn(iso: string | null, now: number): string | null {
  if (!iso) return null
  const at = Date.parse(iso)
  return Number.isNaN(at) ? null : `resets in ${fmtDur(Math.max(0, at - now))}`
}

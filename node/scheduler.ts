import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, statSync, existsSync } from 'fs'
import type { Settings } from './db.js'

export const USAGE_CACHE: string = process.env.CLAUDE_USAGE_CACHE
  ?? join(homedir(), '.claude', '.usage_cache.json')

const USAGE_API     = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SVC  = 'Claude Code-credentials'
const MEM_CACHE_TTL = 300_000  // 5 min in ms

export interface UsageData {
  five_hour_pct:    number
  weekly_pct:       number
  weekly_resets_at: string | null
  age_s:            number
  stale:            boolean
  source:           'api' | 'file'
}

export interface CanRunResult {
  ok:             boolean
  provider:       'max' | null
  reason:         string
  next_idle_in_s: number
}

interface KeychainOAuth {
  accessToken?: string
  refreshToken?: string
  expiresAt?:   number
}

interface ApiUsageResponse {
  five_hour?: { utilization?: number; resets_at?: string }
  seven_day?: { utilization?: number; resets_at?: string }
}

let memCache: UsageData | null = null
let memCacheTs = 0

// ── OAuth token ────────────────────────────────────────────────────────────────

export function readKeychainToken(): string | null {
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SVC, '-w'], {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()
    const data = JSON.parse(raw) as { claudeAiOauth?: KeychainOAuth }
    const oauth = data.claudeAiOauth ?? {}
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
      console.warn('[scheduler] OAuth token expired — waiting for Claude Code to refresh it')
      return null
    }
    return oauth.accessToken ?? null
  } catch (e) {
    console.warn('[scheduler] keychain read failed:', (e as Error).message)
    return null
  }
}

// ── Live API fetch ─────────────────────────────────────────────────────────────

export async function fetchUsageFromApi(): Promise<UsageData | null> {
  const token = readKeychainToken()
  if (!token) return null

  try {
    const resp = await fetch(USAGE_API, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(5000),
    })
    if (resp.status === 401) {
      console.warn('[scheduler] API 401 — token expired, waiting for Claude Code to refresh it')
      return null
    }
    if (resp.status === 429) {
      console.warn('[scheduler] API 429 — rate limited, will retry next poll')
      return null
    }
    if (!resp.ok) {
      console.warn(`[scheduler] API HTTP ${resp.status}`)
      return null
    }
    const data = await resp.json() as ApiUsageResponse
    const fiveH  = data.five_hour  ?? {}
    const sevenD = data.seven_day  ?? {}
    if (fiveH.utilization == null || sevenD.utilization == null) return null

    return {
      five_hour_pct:    fiveH.utilization,
      weekly_pct:       sevenD.utilization,
      weekly_resets_at: sevenD.resets_at ?? null,
      age_s:            0,
      stale:            false,
      source:           'api',
    }
  } catch (e) {
    console.warn('[scheduler] API fetch failed:', (e as Error).message)
    return null
  }
}

// ── File fallback ──────────────────────────────────────────────────────────────

function readUsageFromFile(cacheStaleS = 1800): UsageData | null {
  if (!existsSync(USAGE_CACHE)) return null
  try {
    const ageS = (Date.now() - statSync(USAGE_CACHE).mtimeMs) / 1000
    const data = JSON.parse(readFileSync(USAGE_CACHE, 'utf8')) as {
      rate_limits?: {
        five_hour?: { used_percentage?: number }
        seven_day?: { used_percentage?: number; resets_at?: number }
      }
    }
    const rl        = data.rate_limits ?? {}
    const fiveHPct  = rl.five_hour?.used_percentage
    const weeklyPct = rl.seven_day?.used_percentage
    if (fiveHPct == null || weeklyPct == null) return null
    const resetsEpoch = rl.seven_day?.resets_at
    return {
      five_hour_pct:    fiveHPct,
      weekly_pct:       weeklyPct,
      weekly_resets_at: resetsEpoch ? new Date(resetsEpoch * 1000).toISOString() : null,
      age_s:            ageS,
      stale:            ageS > cacheStaleS,
      source:           'file',
    }
  } catch (e) {
    console.warn('[scheduler] file read failed:', (e as Error).message)
    return null
  }
}

// ── TTL cache ──────────────────────────────────────────────────────────────────

export async function readUsage({ cacheStaleS = 1800, forceRefresh = false } = {}): Promise<UsageData | null> {
  const now = Date.now()
  if (!forceRefresh && memCache && (now - memCacheTs) < MEM_CACHE_TTL) {
    return memCache
  }
  const usage = await fetchUsageFromApi()
  if (usage) {
    memCache   = usage
    memCacheTs = now
    return usage
  }
  return readUsageFromFile(cacheStaleS)
}

// ── Time gate ──────────────────────────────────────────────────────────────────

function localHour(date: Date, tz: string): number {
  try {
    return parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(date)
    )
  } catch {
    return date.getUTCHours()
  }
}

export function isCodingWindow(now = new Date(), startH = 16, endH = 2, tz = 'America/Los_Angeles'): boolean {
  const h = localHour(now, tz)
  return h >= startH || h < endH
}

export function nextIdleInS(now = new Date(), startH = 16, endH = 2, tz = 'America/Los_Angeles'): number {
  if (!isCodingWindow(now, startH, endH, tz)) return 0
  const h = localHour(now, tz)
  const m = now.getMinutes()
  const s = now.getSeconds()
  const remaining = h >= startH
    ? (24 - h + endH) * 3600 - m * 60 - s
    : (endH - h) * 3600 - m * 60 - s
  return Math.max(60, remaining)
}

// ── Gate check ─────────────────────────────────────────────────────────────────

export async function canRun(usage: UsageData | null, cfg: Settings): Promise<CanRunResult> {
  const startH   = parseInt(cfg.CODING_START_H)
  const endH     = parseInt(cfg.CODING_END_H)
  const tz       = cfg.TIMEZONE
  const fiveHT   = parseFloat(cfg.FIVE_HOUR_PAUSE_PCT)
  const reserve  = parseFloat(cfg.WEEKLY_RESERVE_PCT)
  const hardStop = parseFloat(cfg.WEEKLY_HARD_STOP_PCT)
  const staleS   = parseFloat(cfg.CACHE_STALE_MIN) * 60

  const now = new Date()

  if (isCodingWindow(now, startH, endH, tz)) {
    const idleIn = nextIdleInS(now, startH, endH, tz)
    return {
      ok: false, provider: null, next_idle_in_s: idleIn,
      reason: `coding window (${startH}:00–${endH}:00 ${tz}); idle in ${Math.floor(idleIn / 60)}m`,
    }
  }

  const u = usage ?? await readUsage({ cacheStaleS: staleS })

  if (u && !u.stale) {
    const ceiling = 100 - reserve
    if (u.five_hour_pct >= fiveHT) return {
      ok: false, provider: null, next_idle_in_s: 0,
      reason: `5h=${u.five_hour_pct.toFixed(0)}% ≥ ${fiveHT.toFixed(0)}% — pausing to protect coding budget`,
    }
    if (u.weekly_pct >= hardStop) return {
      ok: false, provider: null, next_idle_in_s: 0,
      reason: `weekly=${u.weekly_pct.toFixed(0)}% ≥ ${hardStop.toFixed(0)}% — hard stop until ${u.weekly_resets_at ?? '?'}`,
    }
    if (u.weekly_pct >= ceiling) return {
      ok: false, provider: null, next_idle_in_s: 0,
      reason: `weekly=${u.weekly_pct.toFixed(0)}% ≥ ${ceiling.toFixed(0)}% — reserving ${reserve.toFixed(0)}% for coding`,
    }
  }

  return { ok: true, provider: 'max', reason: 'idle window, budget healthy', next_idle_in_s: 0 }
}

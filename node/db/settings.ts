import { sql } from 'drizzle-orm'
import { db, schema } from './client.js'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Settings {
  CODING_WINDOW_ENABLED: string   // '0' or '1'
  CODING_START_H:       string
  CODING_END_H:         string
  TIMEZONE:             string
  FIVE_HOUR_PAUSE_PCT:  string
  WEEKLY_RESERVE_PCT:   string
  WEEKLY_HARD_STOP_PCT: string
  POLL_INTERVAL_MIN:    string
  CACHE_STALE_MIN:      string
  TASK_TIMEOUT_S:       string   // kill timer per task spawn, in seconds (default 600 = 10 min)
  [key: string]: string
}

export const SETTING_DEFAULTS: Settings = {
  CODING_WINDOW_ENABLED: process.env.CODING_WINDOW_ENABLED ?? '0',
  CODING_START_H:       process.env.CODING_START_H        ?? '9',
  CODING_END_H:         process.env.CODING_END_H          ?? '18',
  TIMEZONE:             process.env.TIMEZONE              ?? 'America/Los_Angeles',
  FIVE_HOUR_PAUSE_PCT:  process.env.FIVE_HOUR_PAUSE_PCT   ?? '75',
  WEEKLY_RESERVE_PCT:   process.env.WEEKLY_RESERVE_PCT    ?? '35',
  WEEKLY_HARD_STOP_PCT: process.env.WEEKLY_HARD_STOP_PCT  ?? '90',
  POLL_INTERVAL_MIN:    process.env.POLL_INTERVAL_MIN     ?? '5',
  CACHE_STALE_MIN:      process.env.CACHE_STALE_MIN       ?? '30',
  TASK_TIMEOUT_S:       process.env.TASK_TIMEOUT_S        ?? '600',
  // Teleport: cross-folder is always-on locally; cross-Mac is opt-in. When
  // enabled, the daemon advertises/browses on the LAN and serves /teleport to
  // peers that present a matching TELEPORT_TOKEN.
  TELEPORT_NETWORK_ENABLED: process.env.TELEPORT_NETWORK_ENABLED ?? '0',
  TELEPORT_TOKEN:           process.env.TELEPORT_TOKEN           ?? '',
  TELEPORT_DEFAULT_WINDOW:  process.env.TELEPORT_DEFAULT_WINDOW  ?? '6h',
}

// ── Settings repository ────────────────────────────────────────────────────────

export function getSettings(): Settings {
  const rows = db.select().from(schema.settings).all()
  return { ...SETTING_DEFAULTS, ...Object.fromEntries(rows.map(r => [r.key, r.value])) }
}

export function updateSettings(updates: Partial<Settings>): void {
  const allowed = new Set(Object.keys(SETTING_DEFAULTS))
  const unknown = Object.keys(updates).filter(k => !allowed.has(k))
  if (unknown.length) throw new Error(`Unknown settings: ${unknown.join(', ')}`)

  db.transaction((tx) => {
    for (const [key, value] of Object.entries(updates)) {
      tx.insert(schema.settings)
        .values({ key, value: String(value) })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: {
            value: String(value),
            updated_at: sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))` as unknown as string,
          },
        })
        .run()
    }
  })
}

import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DB_PATH = process.env.RESTWALKER_DB
  ?? join(homedir(), '.restwalker', 'restwalker.db')

const DATA_DIR = join(homedir(), '.restwalker')
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

export const SETTING_DEFAULTS = {
  CODING_START_H:      process.env.CODING_START_H       ?? '16',
  CODING_END_H:        process.env.CODING_END_H         ?? '2',
  TIMEZONE:            process.env.TIMEZONE             ?? 'America/Los_Angeles',
  FIVE_HOUR_PAUSE_PCT: process.env.FIVE_HOUR_PAUSE_PCT  ?? '75',
  WEEKLY_RESERVE_PCT:  process.env.WEEKLY_RESERVE_PCT   ?? '35',
  WEEKLY_HARD_STOP_PCT:process.env.WEEKLY_HARD_STOP_PCT ?? '90',
  POLL_INTERVAL_MIN:   process.env.POLL_INTERVAL_MIN    ?? '5',
  CACHE_STALE_MIN:     process.env.CACHE_STALE_MIN      ?? '30',
}

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      five_hour_pct    REAL    NOT NULL,
      weekly_pct       REAL    NOT NULL,
      weekly_resets_at TEXT,
      recorded_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS usage_snapshots_recorded_at
      ON usage_snapshots(recorded_at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `)

  const insert = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
  )
  const insertMany = db.transaction((defaults) => {
    for (const [k, v] of Object.entries(defaults)) insert.run(k, v)
  })
  insertMany(SETTING_DEFAULTS)

  db.prepare(
    `DELETE FROM usage_snapshots
     WHERE recorded_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-14 days')`
  ).run()
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  return { ...SETTING_DEFAULTS, ...Object.fromEntries(rows.map(r => [r.key, r.value])) }
}

export function updateSettings(updates) {
  const allowed = new Set(Object.keys(SETTING_DEFAULTS))
  const unknown = Object.keys(updates).filter(k => !allowed.has(k))
  if (unknown.length) throw new Error(`Unknown settings: ${unknown.join(', ')}`)

  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,
    updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
  `)
  const upsertMany = db.transaction((obj) => {
    for (const [k, v] of Object.entries(obj)) upsert.run(k, String(v))
  })
  upsertMany(updates)
}

export function recordSnapshot(fiveHourPct, weeklyPct, weeklyResetsAt) {
  db.prepare(
    `INSERT INTO usage_snapshots (five_hour_pct, weekly_pct, weekly_resets_at) VALUES (?,?,?)`
  ).run(fiveHourPct, weeklyPct, weeklyResetsAt ?? null)
}

export function latestSnapshot() {
  return db.prepare(
    `SELECT * FROM usage_snapshots ORDER BY recorded_at DESC LIMIT 1`
  ).get() ?? null
}

export function usageHistory(hours = 48) {
  return db.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H:', recorded_at) ||
        printf('%02d', (CAST(strftime('%M', recorded_at) AS INTEGER) / 15) * 15) ||
        ':00Z' AS bucket,
      ROUND(AVG(five_hour_pct), 1) AS five_hour_pct,
      ROUND(AVG(weekly_pct), 1)    AS weekly_pct,
      COUNT(*)                      AS samples
    FROM usage_snapshots
    WHERE recorded_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-' || ? || ' hours')
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(hours)
}

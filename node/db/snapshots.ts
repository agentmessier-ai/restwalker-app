import { desc, sql } from 'drizzle-orm'
import { db, client, schema } from './client.js'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Snapshot {
  id:               number
  five_hour_pct:    number
  weekly_pct:       number
  weekly_resets_at: string | null
  recorded_at:      string
}

export interface HistoryBucket {
  bucket:        string
  five_hour_pct: number
  weekly_pct:    number
  samples:       number
}

// ── Snapshots repository ───────────────────────────────────────────────────────

export function recordSnapshot(fiveHourPct: number, weeklyPct: number, weeklyResetsAt: string | null): void {
  db.insert(schema.usageSnapshots)
    .values({ five_hour_pct: fiveHourPct, weekly_pct: weeklyPct, weekly_resets_at: weeklyResetsAt })
    .run()
}

export function latestSnapshot(): Snapshot | null {
  return db.select().from(schema.usageSnapshots)
    .orderBy(desc(schema.usageSnapshots.recorded_at))
    .limit(1)
    .get() as Snapshot | null
}

export function usageHistory(hours = 48): HistoryBucket[] {
  // Complex bucketing expression kept as raw SQL — no Drizzle equivalent for printf+strftime grouping
  return client.prepare(`
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
  `).all(hours) as HistoryBucket[]
}

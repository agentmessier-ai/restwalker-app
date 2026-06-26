import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq, desc, asc, sql, and, lte, inArray } from 'drizzle-orm'
import { existsSync, mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { lookup as mimeLookup } from './mime.js'

import * as schema from './schema.js'

// ── Bootstrap ──────────────────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), '.restwalker')
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

export const WORKSPACE_DIR = join(DATA_DIR, 'workspace')
if (!existsSync(WORKSPACE_DIR)) mkdirSync(WORKSPACE_DIR, { recursive: true })

const DB_PATH = process.env.RESTWALKER_DB ?? join(DATA_DIR, 'restwalker.db')

export const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

const client = new Database(DB_PATH)
client.pragma('journal_mode = WAL')

const db = drizzle(client, { schema })

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
  [key: string]: string
}

export interface HistoryBucket {
  bucket:        string
  five_hour_pct: number
  weekly_pct:    number
  samples:       number
}

export type Provider     = typeof schema.providers.$inferSelect
export type Task         = typeof schema.tasks.$inferSelect
export type Artifact     = typeof schema.artifacts.$inferSelect
export type SystemPrompt = typeof schema.systemPrompts.$inferSelect
export type TaskStatus   = 'scheduled' | 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
export type TaskSchedule = 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly'

export interface Snapshot {
  id:               number
  five_hour_pct:    number
  weekly_pct:       number
  weekly_resets_at: string | null
  recorded_at:      string
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
}

// ── Schema migration ───────────────────────────────────────────────────────────

const DEFAULT_CLAUDE_ARGS = JSON.stringify([
  '--print', '--permission-mode', 'auto', '--output-format', 'text',
  '--model', '{{model}}', '{{task}}',
])

export const BUILTIN_SYSTEM_PROMPT = `\
## Restwalker Artifact Protocol
You are running as a background task inside restwalker — an idle-time Claude task runner that uses your Claude Max plan's leftover tokens to do meaningful work while you rest.

Your task workspace is already set as your working directory. Any files you create here are automatically tracked and shown to the user in the restwalker dashboard.

When you create or generate a file that the user should see (a report, a skill, a script, generated code, data, etc.), declare it by outputting a line in this exact format:

ARTIFACT: {"path": "/absolute/path/to/file", "description": "one-line description of what this file is"}

Rules:
- Use the absolute path
- One ARTIFACT line per file
- Declare it after the file is written, not before
- Only declare files meant for the user to review — not intermediate scratch files

---

`

export function migrate(): void {
  client.exec(`
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

    CREATE TABLE IF NOT EXISTS providers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      command       TEXT    NOT NULL,
      args_template TEXT    NOT NULL DEFAULT '[]',
      is_default    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      description    TEXT    NOT NULL,
      cwd            TEXT    NOT NULL DEFAULT '',
      model          TEXT    NOT NULL DEFAULT 'claude-sonnet-4-6',
      provider_id    INTEGER REFERENCES providers(id),
      schedule       TEXT    NOT NULL DEFAULT 'once',
      next_run_at    TEXT,
      status         TEXT    NOT NULL DEFAULT 'pending',
      result         TEXT,
      workspace_path TEXT,
      session_id     TEXT,
      session_path   TEXT,
      tool_calls     INTEGER NOT NULL DEFAULT 0,
      tokens_used    INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      started_at     TEXT,
      finished_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      path        TEXT    NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      mime_type   TEXT    NOT NULL DEFAULT 'text/plain',
      size        INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS system_prompts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      version    INTEGER NOT NULL,
      label      TEXT    NOT NULL DEFAULT '',
      content    TEXT    NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `)

  // Seed settings defaults
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
      tx.insert(schema.settings).values({ key, value }).onConflictDoNothing().run()
    }
  })

  // Column migrations for existing DBs
  const cols = (client.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(c => c.name)
  if (cols.length && !cols.includes('model'))          client.exec("ALTER TABLE tasks ADD COLUMN model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6'")
  if (cols.length && !cols.includes('provider_id'))    client.exec('ALTER TABLE tasks ADD COLUMN provider_id INTEGER REFERENCES providers(id)')
  if (cols.length && !cols.includes('schedule'))       client.exec("ALTER TABLE tasks ADD COLUMN schedule TEXT NOT NULL DEFAULT 'once'")
  if (cols.length && !cols.includes('next_run_at'))    client.exec('ALTER TABLE tasks ADD COLUMN next_run_at TEXT')
  if (cols.length && !cols.includes('workspace_path')) client.exec('ALTER TABLE tasks ADD COLUMN workspace_path TEXT')

  // Seed default provider
  const count = db.select({ n: sql<number>`count(*)` }).from(schema.providers).get()!.n
  if (!count) {
    db.insert(schema.providers).values({
      name: 'Claude Code',
      command: process.env.CLAUDE_BIN ?? 'claude',
      args_template: DEFAULT_CLAUDE_ARGS,
      is_default: 1,
    }).run()
  }

  // Seed builtin system prompt (once)
  const spCount = db.select({ n: sql<number>`count(*)` }).from(schema.systemPrompts).where(eq(schema.systemPrompts.is_builtin, 1)).get()!.n
  if (!spCount) {
    db.insert(schema.systemPrompts).values({
      version: 1, label: 'Built-in default', content: BUILTIN_SYSTEM_PROMPT, is_builtin: 1,
    }).run()
  }

  // Prune old snapshots
  db.delete(schema.usageSnapshots)
    .where(sql`${schema.usageSnapshots.recorded_at} < strftime('%Y-%m-%dT%H:%M:%SZ','now','-14 days')`)
    .run()
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

// ── Providers repository ───────────────────────────────────────────────────────

export function getProviders(): Provider[] {
  return db.select().from(schema.providers)
    .orderBy(desc(schema.providers.is_default), asc(schema.providers.id))
    .all()
}

export function getProvider(id: number): Provider | null {
  return db.select().from(schema.providers).where(eq(schema.providers.id, id)).get() ?? null
}

export function getDefaultProvider(): Provider | null {
  return db.select().from(schema.providers).where(eq(schema.providers.is_default, 1)).limit(1).get() ?? null
}

export function addProvider(name: string, command: string, argsTemplate: string): Provider {
  return db.insert(schema.providers)
    .values({ name, command, args_template: argsTemplate })
    .returning()
    .get()!
}

export function updateProvider(id: number, u: Partial<Pick<Provider, 'name' | 'command' | 'args_template'>>): void {
  const set: Partial<typeof schema.providers.$inferInsert> = {}
  if (u.name          !== undefined) set.name          = u.name
  if (u.command       !== undefined) set.command       = u.command
  if (u.args_template !== undefined) set.args_template = u.args_template
  if (!Object.keys(set).length) return
  db.update(schema.providers).set(set).where(eq(schema.providers.id, id)).run()
}

export function setDefaultProvider(id: number): void {
  db.transaction((tx) => {
    tx.update(schema.providers).set({ is_default: 0 }).run()
    tx.update(schema.providers).set({ is_default: 1 }).where(eq(schema.providers.id, id)).run()
  })
}

export function deleteProvider(id: number): void {
  db.delete(schema.providers).where(eq(schema.providers.id, id)).run()
}

// ── Tasks repository ───────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-6'

function computeNextRun(schedule: TaskSchedule): string {
  const d = new Date()
  if (schedule === 'hourly')  return new Date(d.getTime() + 3_600_000).toISOString()
  if (schedule === 'daily')   return new Date(d.getTime() + 86_400_000).toISOString()
  if (schedule === 'weekly')  return new Date(d.getTime() + 7 * 86_400_000).toISOString()
  if (schedule === 'monthly') { d.setMonth(d.getMonth() + 1); return d.toISOString() }
  return d.toISOString()
}

export function addTask(
  description: string, cwd = '', model = DEFAULT_MODEL,
  providerId?: number | null, schedule: TaskSchedule = 'once',
): Task {
  return db.insert(schema.tasks).values({
    description,
    cwd: cwd || '',
    model: model || DEFAULT_MODEL,
    provider_id: providerId ?? null,
    schedule,
  }).returning().get()!
}

export function createNextRun(task: Task): Task | null {
  if (!task.schedule || task.schedule === 'once') return null
  return db.insert(schema.tasks).values({
    description: task.description,
    cwd:         task.cwd,
    model:       task.model,
    provider_id: task.provider_id,
    schedule:    task.schedule,
    status:      'scheduled',
    next_run_at: computeNextRun(task.schedule as TaskSchedule),
  }).returning().get()!
}

export function getScheduledDueTasks(): Task[] {
  return db.select().from(schema.tasks)
    .where(and(
      eq(schema.tasks.status, 'scheduled'),
      lte(schema.tasks.next_run_at, sql`strftime('%Y-%m-%dT%H:%M:%SZ','now')`),
    ))
    .all()
}

export function getTasks(limit = 25, offset = 0, opts?: {
  status?: TaskStatus; sort?: 'created' | 'finished' | 'duration'; dir?: 'asc' | 'desc'
}): Task[] {
  const { status, sort = 'created', dir = 'desc' } = opts ?? {}
  const orderFn = dir === 'asc' ? asc : desc
  const orderExpr = sort === 'finished'
    ? orderFn(schema.tasks.finished_at)
    : sort === 'duration'
    ? orderFn(sql`(unixepoch(finished_at) - unixepoch(started_at))`)
    : orderFn(schema.tasks.id)
  if (status) {
    return db.select().from(schema.tasks)
      .where(eq(schema.tasks.status, status))
      .orderBy(orderExpr).limit(limit).offset(offset).all()
  }
  return db.select().from(schema.tasks)
    .orderBy(orderExpr).limit(limit).offset(offset).all()
}

export function getTaskCount(status?: TaskStatus): number {
  if (status) {
    return db.select({ n: sql<number>`count(*)` }).from(schema.tasks)
      .where(eq(schema.tasks.status, status)).get()!.n
  }
  return db.select({ n: sql<number>`count(*)` }).from(schema.tasks).get()!.n
}

export function getTask(id: number): Task | null {
  return db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get() ?? null
}

export function setTaskPending(id: number): void {
  db.update(schema.tasks)
    .set({ status: 'pending', next_run_at: null })
    .where(eq(schema.tasks.id, id))
    .run()
}

export function setTaskRunning(id: number): void {
  db.update(schema.tasks)
    .set({ status: 'running', started_at: sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))` as unknown as string })
    .where(eq(schema.tasks.id, id))
    .run()
}

export function setTaskDone(id: number, updates: {
  result?: string; session_id?: string; session_path?: string
  tool_calls?: number; tokens_used?: number; workspace_path?: string
}): void {
  const NOW_SQL = sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))` as unknown as string
  const set: Partial<typeof schema.tasks.$inferInsert> = {
    status:      'done',
    finished_at: NOW_SQL,
  }
  if (updates.result         !== undefined) set.result         = updates.result
  if (updates.session_id     !== undefined) set.session_id     = updates.session_id
  if (updates.session_path   !== undefined) set.session_path   = updates.session_path
  if (updates.tool_calls     !== undefined) set.tool_calls     = updates.tool_calls
  if (updates.tokens_used    !== undefined) set.tokens_used    = updates.tokens_used
  if (updates.workspace_path !== undefined) set.workspace_path = updates.workspace_path
  db.update(schema.tasks).set(set).where(eq(schema.tasks.id, id)).run()
}

export function setTaskFailed(id: number, error: string): void {
  db.update(schema.tasks)
    .set({ status: 'failed', result: error, finished_at: sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))` as unknown as string })
    .where(eq(schema.tasks.id, id))
    .run()
}

export function cancelTask(id: number): void {
  db.update(schema.tasks)
    .set({ status: 'cancelled' })
    .where(and(
      eq(schema.tasks.id, id),
      inArray(schema.tasks.status, ['pending', 'scheduled']),
    ))
    .run()
}

export function deleteTask(id: number): boolean {
  const result = db.delete(schema.tasks)
    .where(and(
      eq(schema.tasks.id, id),
      inArray(schema.tasks.status, ['pending', 'scheduled', 'done', 'failed', 'cancelled']),
    ))
    .run()
  return result.changes > 0
}

// ── Artifacts repository ───────────────────────────────────────────────────────

export function saveArtifacts(taskId: number, items: { path: string; description: string }[]): Artifact[] {
  return items.map(({ path, description }) => {
    let size = 0
    try { size = statSync(path).size } catch {}
    return db.insert(schema.artifacts).values({
      task_id: taskId, path, description,
      mime_type: mimeLookup(path),
      size,
    }).returning().get()!
  })
}

export function getArtifacts(taskId: number): Artifact[] {
  return db.select().from(schema.artifacts)
    .where(eq(schema.artifacts.task_id, taskId))
    .orderBy(asc(schema.artifacts.id))
    .all()
}

export function getArtifact(id: number): Artifact | null {
  return db.select().from(schema.artifacts).where(eq(schema.artifacts.id, id)).get() ?? null
}

// ── System prompt repository ───────────────────────────────────────────────────

export function getActiveSystemPrompt(): SystemPrompt {
  // Active = highest version (user's latest save), or builtin if no user versions
  const active = db.select().from(schema.systemPrompts)
    .orderBy(desc(schema.systemPrompts.version))
    .limit(1).get()
  if (active) return active
  // Fallback: seed and return builtin (shouldn't happen after migrate())
  return db.insert(schema.systemPrompts).values({
    version: 1, label: 'Built-in default', content: BUILTIN_SYSTEM_PROMPT, is_builtin: 1,
  }).returning().get()!
}

export function getSystemPromptVersions(): SystemPrompt[] {
  return db.select().from(schema.systemPrompts)
    .orderBy(desc(schema.systemPrompts.version))
    .all()
}

export function saveSystemPromptVersion(content: string, label = ''): SystemPrompt {
  const maxRow = db.select({ v: sql<number>`max(version)` }).from(schema.systemPrompts).get()
  const nextVersion = (maxRow?.v ?? 0) + 1
  return db.insert(schema.systemPrompts).values({
    version: nextVersion, label, content, is_builtin: 0,
  }).returning().get()!
}

export function getBuiltinSystemPrompt(): SystemPrompt {
  return db.select().from(schema.systemPrompts)
    .where(eq(schema.systemPrompts.is_builtin, 1))
    .orderBy(asc(schema.systemPrompts.version))
    .limit(1).get()!
}

export function getSystemPromptById(id: number): SystemPrompt | null {
  return db.select().from(schema.systemPrompts).where(eq(schema.systemPrompts.id, id)).get() ?? null
}

export function deleteSystemPromptVersion(id: number): boolean {
  // Cannot delete the builtin
  const sp = db.select().from(schema.systemPrompts).where(eq(schema.systemPrompts.id, id)).get()
  if (!sp || sp.is_builtin) return false
  db.delete(schema.systemPrompts).where(eq(schema.systemPrompts.id, id)).run()
  return true
}

export function queueStats(): { scheduled: number; pending: number; running: number; done: number; failed: number; total: number } {
  // Conditional aggregation kept as raw SQL for readability
  const row = client.prepare(`
    SELECT
      SUM(CASE WHEN status='scheduled' THEN 1 ELSE 0 END) AS scheduled,
      SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='running'   THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status='done'      THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status='failed'    THEN 1 ELSE 0 END) AS failed,
      COUNT(*)                                             AS total
    FROM tasks
  `).get() as { scheduled: number; pending: number; running: number; done: number; failed: number; total: number }
  return row
}

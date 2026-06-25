import Database, { type Database as DB } from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DATA_DIR = join(homedir(), '.restwalker')
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

const DB_PATH = process.env.RESTWALKER_DB ?? join(DATA_DIR, 'restwalker.db')

export const SKILLS_DIR = process.env.SKILLS_DIR ?? join(homedir(), '.claude', 'skills')
export const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

const db: DB = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

export interface Settings {
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

export const SETTING_DEFAULTS: Settings = {
  CODING_START_H:       process.env.CODING_START_H        ?? '16',
  CODING_END_H:         process.env.CODING_END_H          ?? '2',
  TIMEZONE:             process.env.TIMEZONE              ?? 'America/Los_Angeles',
  FIVE_HOUR_PAUSE_PCT:  process.env.FIVE_HOUR_PAUSE_PCT   ?? '75',
  WEEKLY_RESERVE_PCT:   process.env.WEEKLY_RESERVE_PCT    ?? '35',
  WEEKLY_HARD_STOP_PCT: process.env.WEEKLY_HARD_STOP_PCT  ?? '90',
  POLL_INTERVAL_MIN:    process.env.POLL_INTERVAL_MIN     ?? '5',
  CACHE_STALE_MIN:      process.env.CACHE_STALE_MIN       ?? '30',
}

// ── Queue types ────────────────────────────────────────────────────────────────

export interface Provider {
  id:            number
  name:          string
  command:       string
  args_template: string   // JSON string[] with {{task}} {{model}} {{cwd}} placeholders
  is_default:    number
  created_at:    string
}

export type TaskStatus   = 'scheduled' | 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
export type TaskSchedule = 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly'

export interface Task {
  id:           number
  description:  string
  cwd:          string
  model:        string
  provider_id:  number | null
  schedule:     TaskSchedule
  next_run_at:  string | null
  status:       TaskStatus
  result:       string | null
  session_id:   string | null
  session_path: string | null
  skill_path:   string | null
  tool_calls:   number
  tokens_used:  number
  created_at:   string
  started_at:   string | null
  finished_at:  string | null
}

export interface Skill {
  id:          number
  name:        string
  description: string
  task_id:     number
  session_id:  string
  tool_calls:  number
  path:        string
  created_at:  string
}

const DEFAULT_CLAUDE_ARGS = JSON.stringify([
  '--print', '--permission-mode', 'auto', '--output-format', 'text',
  '--model', '{{model}}', '{{task}}',
])

export function migrate(): void {
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

    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      description  TEXT    NOT NULL,
      cwd          TEXT    NOT NULL DEFAULT '',
      model        TEXT    NOT NULL DEFAULT 'claude-sonnet-4-6',
      provider_id  INTEGER REFERENCES providers(id),
      schedule     TEXT    NOT NULL DEFAULT 'once',
      next_run_at  TEXT,
      status       TEXT    NOT NULL DEFAULT 'pending',
      result       TEXT,
      session_id   TEXT,
      session_path TEXT,
      skill_path   TEXT,
      tool_calls   INTEGER NOT NULL DEFAULT 0,
      tokens_used  INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      started_at   TEXT,
      finished_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS providers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      command       TEXT    NOT NULL,
      args_template TEXT    NOT NULL DEFAULT '[]',
      is_default    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS skills (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT NOT NULL,
      task_id     INTEGER NOT NULL,
      session_id  TEXT NOT NULL,
      tool_calls  INTEGER NOT NULL DEFAULT 0,
      path        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `)

  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  const insertMany = db.transaction((defaults: Settings) => {
    for (const [k, v] of Object.entries(defaults)) insert.run(k, v)
  })
  insertMany(SETTING_DEFAULTS)

  // column migrations for existing DBs
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(c => c.name)
  if (cols.length && !cols.includes('model')) {
    db.exec("ALTER TABLE tasks ADD COLUMN model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6'")
  }
  if (cols.length && !cols.includes('provider_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN provider_id INTEGER REFERENCES providers(id)')
  }
  if (cols.length && !cols.includes('schedule')) {
    db.exec("ALTER TABLE tasks ADD COLUMN schedule TEXT NOT NULL DEFAULT 'once'")
  }
  if (cols.length && !cols.includes('next_run_at')) {
    db.exec('ALTER TABLE tasks ADD COLUMN next_run_at TEXT')
  }

  // seed default provider if none exist
  const pCount = (db.prepare('SELECT COUNT(*) AS n FROM providers').get() as { n: number }).n
  if (!pCount) {
    const claudeBin = process.env.CLAUDE_BIN ?? 'claude'
    db.prepare('INSERT INTO providers (name, command, args_template, is_default) VALUES (?,?,?,1)')
      .run('Claude Code', claudeBin, DEFAULT_CLAUDE_ARGS)
  }

  db.prepare(
    `DELETE FROM usage_snapshots
     WHERE recorded_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-14 days')`
  ).run()
}

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  return { ...SETTING_DEFAULTS, ...Object.fromEntries(rows.map(r => [r.key, r.value])) }
}

export function updateSettings(updates: Partial<Settings>): void {
  const allowed = new Set(Object.keys(SETTING_DEFAULTS))
  const unknown = Object.keys(updates).filter(k => !allowed.has(k))
  if (unknown.length) throw new Error(`Unknown settings: ${unknown.join(', ')}`)

  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,
    updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
  `)
  const upsertMany = db.transaction((obj: Partial<Settings>) => {
    for (const [k, v] of Object.entries(obj)) upsert.run(k, String(v))
  })
  upsertMany(updates)
}

export function recordSnapshot(fiveHourPct: number, weeklyPct: number, weeklyResetsAt: string | null): void {
  db.prepare(
    'INSERT INTO usage_snapshots (five_hour_pct, weekly_pct, weekly_resets_at) VALUES (?,?,?)'
  ).run(fiveHourPct, weeklyPct, weeklyResetsAt)
}

export function latestSnapshot(): Snapshot | null {
  return db.prepare(
    'SELECT * FROM usage_snapshots ORDER BY recorded_at DESC LIMIT 1'
  ).get() as Snapshot | null
}

export function usageHistory(hours = 48): HistoryBucket[] {
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
  `).all(hours) as HistoryBucket[]
}

// ── Providers ──────────────────────────────────────────────────────────────────

export function getProviders(): Provider[] {
  return db.prepare('SELECT * FROM providers ORDER BY is_default DESC, id ASC').all() as Provider[]
}

export function getProvider(id: number): Provider | null {
  return db.prepare('SELECT * FROM providers WHERE id=?').get(id) as Provider | null
}

export function getDefaultProvider(): Provider | null {
  return db.prepare('SELECT * FROM providers WHERE is_default=1 LIMIT 1').get() as Provider | null
}

export function addProvider(name: string, command: string, argsTemplate: string): Provider {
  return db.prepare(
    'INSERT INTO providers (name, command, args_template) VALUES (?,?,?) RETURNING *'
  ).get(name, command, argsTemplate) as Provider
}

export function updateProvider(id: number, u: Partial<Pick<Provider, 'name' | 'command' | 'args_template'>>): void {
  const sets: string[] = [], vals: unknown[] = []
  if (u.name          !== undefined) { sets.push('name=?');          vals.push(u.name) }
  if (u.command       !== undefined) { sets.push('command=?');       vals.push(u.command) }
  if (u.args_template !== undefined) { sets.push('args_template=?'); vals.push(u.args_template) }
  if (!sets.length) return
  vals.push(id)
  db.prepare(`UPDATE providers SET ${sets.join(',')} WHERE id=?`).run(...vals as Parameters<typeof db.prepare>[0][])
}

export function setDefaultProvider(id: number): void {
  db.transaction(() => {
    db.prepare('UPDATE providers SET is_default=0').run()
    db.prepare('UPDATE providers SET is_default=1 WHERE id=?').run(id)
  })()
}

export function deleteProvider(id: number): void {
  db.prepare('DELETE FROM providers WHERE id=?').run(id)
}

// ── Queue: tasks ───────────────────────────────────────────────────────────────

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
  return db.prepare(
    'INSERT INTO tasks (description, cwd, model, provider_id, schedule) VALUES (?, ?, ?, ?, ?) RETURNING *'
  ).get(description, cwd || process.env.HOME || '', model || DEFAULT_MODEL, providerId ?? null, schedule) as Task
}

export function createNextRun(task: Task): Task | null {
  if (!task.schedule || task.schedule === 'once') return null
  return db.prepare(
    "INSERT INTO tasks (description,cwd,model,provider_id,schedule,status,next_run_at) VALUES (?,?,?,?,?,'scheduled',?) RETURNING *"
  ).get(task.description, task.cwd, task.model, task.provider_id ?? null, task.schedule, computeNextRun(task.schedule)) as Task
}

export function getScheduledDueTasks(): Task[] {
  return db.prepare(
    "SELECT * FROM tasks WHERE status='scheduled' AND next_run_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now')"
  ).all() as Task[]
}

export function setTaskPending(id: number): void {
  db.prepare("UPDATE tasks SET status='pending', next_run_at=NULL WHERE id=?").run(id)
}

export function setTaskRunning(id: number): void {
  db.prepare(
    "UPDATE tasks SET status='running', started_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?"
  ).run(id)
}

export function setTaskDone(id: number, updates: {
  result?: string; session_id?: string; session_path?: string
  skill_path?: string; tool_calls?: number; tokens_used?: number
}): void {
  db.prepare(`
    UPDATE tasks SET
      status='done',
      finished_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
      result=COALESCE(?,result),
      session_id=COALESCE(?,session_id),
      session_path=COALESCE(?,session_path),
      skill_path=COALESCE(?,skill_path),
      tool_calls=COALESCE(?,tool_calls),
      tokens_used=COALESCE(?,tokens_used)
    WHERE id=?
  `).run(
    updates.result ?? null, updates.session_id ?? null, updates.session_path ?? null,
    updates.skill_path ?? null, updates.tool_calls ?? null, updates.tokens_used ?? null,
    id
  )
}

export function setTaskFailed(id: number, error: string): void {
  db.prepare(
    "UPDATE tasks SET status='failed', result=?, finished_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?"
  ).run(error, id)
}

export function getTasks(limit = 25, offset = 0): Task[] {
  return db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset) as Task[]
}

export function getTaskCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n
}

export function getTask(id: number): Task | null {
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Task | null
}

export function cancelTask(id: number): void {
  db.prepare("UPDATE tasks SET status='cancelled' WHERE id=? AND status IN ('pending','scheduled')").run(id)
}

// ── Queue: skills ──────────────────────────────────────────────────────────────

export function recordSkill(skill: Omit<Skill, 'id' | 'created_at'>): void {
  db.prepare(
    'INSERT INTO skills (name, description, task_id, session_id, tool_calls, path) VALUES (?,?,?,?,?,?)'
  ).run(skill.name, skill.description, skill.task_id, skill.session_id, skill.tool_calls, skill.path)
}

export function getSkills(limit = 20): Skill[] {
  return db.prepare('SELECT * FROM skills ORDER BY id DESC LIMIT ?').all(limit) as Skill[]
}

export function queueStats(): { scheduled: number; pending: number; running: number; done: number; failed: number; skills: number } {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status='scheduled' THEN 1 ELSE 0 END) AS scheduled,
      SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='running'   THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status='done'      THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status='failed'    THEN 1 ELSE 0 END) AS failed
    FROM tasks WHERE status != 'cancelled'
  `).get() as { scheduled: number; pending: number; running: number; done: number; failed: number }
  const total  = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n
  const skills = (db.prepare('SELECT COUNT(*) AS n FROM skills').get() as { n: number }).n
  return { ...row, total, skills }
}

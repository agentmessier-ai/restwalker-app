import { eq, sql } from 'drizzle-orm'
import { db, client, schema, DATA_DIR, WORKSPACE_DIR } from './client.js'
import { SETTING_DEFAULTS } from './settings.js'
import { BUILTIN_SYSTEM_PROMPT } from './system-prompt.js'

// ── Schema migration ───────────────────────────────────────────────────────────

const DEFAULT_CLAUDE_ARGS = JSON.stringify([
  '--print', '--permission-mode', 'auto', '--output-format', 'text',
  '--model', '{{model}}', '{{task}}',
])

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

    CREATE TABLE IF NOT EXISTS task_prompts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      origin_id   INTEGER NOT NULL,
      version     INTEGER NOT NULL,
      title       TEXT    NOT NULL DEFAULT '',
      content     TEXT    NOT NULL,
      cwd         TEXT    NOT NULL DEFAULT '',
      model       TEXT    NOT NULL DEFAULT 'claude-sonnet-4-6',
      provider_id INTEGER,
      schedule    TEXT    NOT NULL DEFAULT 'once',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
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
  if (cols.length && !cols.includes('origin_id'))     client.exec('ALTER TABLE tasks ADD COLUMN origin_id INTEGER')
  if (cols.length && !cols.includes('prompt_id'))     client.exec('ALTER TABLE tasks ADD COLUMN prompt_id INTEGER')

  const providerCols = (client.prepare('PRAGMA table_info(providers)').all() as { name: string }[]).map(c => c.name)
  if (providerCols.length && !providerCols.includes('loop_type')) {
    client.exec("ALTER TABLE providers ADD COLUMN loop_type TEXT NOT NULL DEFAULT 'claude_print'")
  }
  // Clarify the legacy seed name — the print loop runs `claude -p`, i.e. the pipe
  client.exec("UPDATE providers SET name = 'Claude (pipe)' WHERE name IN ('Claude Code', 'Claude Code (CLI)')")

  const taskCols = (client.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(c => c.name)
  if (!taskCols.includes('webhook_pre_url'))    client.exec('ALTER TABLE tasks ADD COLUMN webhook_pre_url TEXT')
  if (!taskCols.includes('webhook_post_url'))   client.exec('ALTER TABLE tasks ADD COLUMN webhook_post_url TEXT')
  if (!taskCols.includes('webhook_timeout_ms')) client.exec('ALTER TABLE tasks ADD COLUMN webhook_timeout_ms INTEGER NOT NULL DEFAULT 10000')
  if (!taskCols.includes('webhook_retry'))      client.exec('ALTER TABLE tasks ADD COLUMN webhook_retry INTEGER NOT NULL DEFAULT 2')
  if (!taskCols.includes('webhook_ignore_ssl')) client.exec('ALTER TABLE tasks ADD COLUMN webhook_ignore_ssl INTEGER NOT NULL DEFAULT 0')

  // Seed default provider
  const count = db.select({ n: sql<number>`count(*)` }).from(schema.providers).get()!.n
  if (!count) {
    db.insert(schema.providers).values({
      name: 'Claude (pipe)',
      command: process.env.CLAUDE_BIN ?? 'claude',
      args_template: DEFAULT_CLAUDE_ARGS,
      loop_type: 'claude_print',
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

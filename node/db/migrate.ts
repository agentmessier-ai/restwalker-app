import { eq, sql } from 'drizzle-orm'
import { db, client, schema } from './client.js'
import { SETTING_DEFAULTS } from './settings.js'
import { BUILTIN_SYSTEM_PROMPT } from './system-prompt.js'

// ── Schema migration ───────────────────────────────────────────────────────────

const DEFAULT_CLAUDE_ARGS = JSON.stringify([
  '--print', '--permission-mode', 'auto', '--output-format', 'text',
  '--model', '{{model}}', '{{task}}',
])

// Flagship example task, seeded once on a fresh install so a new user has a working
// recurring task that showcases restwalker (runs nightly on idle budget; deletable).
// Mirrors examples/tasks/dream-journal.md.
const DREAM_JOURNAL_PROMPT = `You are restwalker's nightly "Dream Journal". Reflect on the last 24 hours of work and produce ONE markdown report. Be concise and concrete — this is a journal, not an essay. Work entirely from local files and the web; do not modify the user's projects.

PART 1 — Distill skills from today's conversations
- Find Claude Code session transcripts modified in the last 24 hours under ~/.claude/projects/ (each line of a .jsonl is one JSON message). Also skim ~/.claude/history.jsonl for recent commands.
- Read enough to spot recurring patterns: a workflow you repeated, a problem you solved more than once, a sequence of steps worth turning into a reusable SKILL.
- For each candidate skill (the best 1–3, not everything), capture: name (kebab-case), when to use it, the concrete steps, why it helps.
- If there were no meaningful conversations, say so plainly and keep the report short.

PART 2 — Best-practice + trending scan (top 1–3 candidates only)
- For each top candidate, use web search to check whether there is a more established, best-practice way to do the same thing. Note what is better and link the source.
- Check GitHub trending for the last ~30 days by fetching https://github.com/trending?since=monthly . Pick the few repos most relevant to how you work, read their READMEs, and compare their approach to yours. Note anything concrete you could adopt.

OUTPUT
- Write a single markdown report to ~/.restwalker/dreams/dream-<YYYY-MM-DD>.md (create the dreams/ directory if needed; use today's date from \`date +%F\`).
- Structure it: a title "# Dream Journal — <date>", then sections "## Distilled skills", "## Best-practice notes", "## Trending & comparisons", "## Action items".
- Then declare the report as an artifact on its own line: ARTIFACT: {"path": "<absolute path>", "description": "Nightly dream journal — distilled skills and best-practice scan"}
- Do NOT auto-install skills or edit ~/.claude/skills. Only recommend; the human decides.`

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
  // Clarify the legacy seed name — the print loop runs `claude -p` (--print)
  client.exec("UPDATE providers SET name = 'claude -p' WHERE name IN ('Claude Code', 'Claude Code (CLI)', 'Claude (pipe)')")

  const taskCols = (client.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(c => c.name)
  if (!taskCols.includes('webhook_pre_url'))    client.exec('ALTER TABLE tasks ADD COLUMN webhook_pre_url TEXT')
  if (!taskCols.includes('webhook_post_url'))   client.exec('ALTER TABLE tasks ADD COLUMN webhook_post_url TEXT')
  if (!taskCols.includes('webhook_retry'))      client.exec('ALTER TABLE tasks ADD COLUMN webhook_retry INTEGER NOT NULL DEFAULT 2')
  if (!taskCols.includes('webhook_ignore_ssl')) client.exec('ALTER TABLE tasks ADD COLUMN webhook_ignore_ssl INTEGER NOT NULL DEFAULT 0')
  // Timeouts are stored in seconds. Migrate legacy ms columns (value / 1000) and drop them.
  if (!taskCols.includes('webhook_timeout_s')) {
    client.exec('ALTER TABLE tasks ADD COLUMN webhook_timeout_s INTEGER NOT NULL DEFAULT 10')
    if (taskCols.includes('webhook_timeout_ms')) client.exec('UPDATE tasks SET webhook_timeout_s = MAX(1, webhook_timeout_ms / 1000)')
  }
  if (!taskCols.includes('timeout_s')) {
    client.exec('ALTER TABLE tasks ADD COLUMN timeout_s INTEGER')
    if (taskCols.includes('timeout_ms')) client.exec('UPDATE tasks SET timeout_s = timeout_ms / 1000 WHERE timeout_ms IS NOT NULL')
  }
  try { if (taskCols.includes('webhook_timeout_ms')) client.exec('ALTER TABLE tasks DROP COLUMN webhook_timeout_ms') } catch { /* sqlite < 3.35 */ }
  try { if (taskCols.includes('timeout_ms'))         client.exec('ALTER TABLE tasks DROP COLUMN timeout_ms') } catch { /* sqlite < 3.35 */ }
  if (!taskCols.includes('tags')) client.exec('ALTER TABLE tasks ADD COLUMN tags TEXT')

  const snapCols = (client.prepare('PRAGMA table_info(usage_snapshots)').all() as { name: string }[]).map(c => c.name)
  if (snapCols.length && !snapCols.includes('five_hour_resets_at')) {
    client.exec('ALTER TABLE usage_snapshots ADD COLUMN five_hour_resets_at TEXT')
  }

  // Setting: TASK_TIMEOUT_MS (ms) → TASK_TIMEOUT_S (seconds)
  const oldTimeout = client.prepare("SELECT value FROM settings WHERE key='TASK_TIMEOUT_MS'").get() as { value?: string } | undefined
  if (oldTimeout?.value) {
    const secs = Math.max(1, Math.round(parseInt(oldTimeout.value) / 1000))
    client.prepare("UPDATE settings SET value=? WHERE key='TASK_TIMEOUT_S'").run(String(secs))
    client.exec("DELETE FROM settings WHERE key='TASK_TIMEOUT_MS'")
  }

  // Seed default provider + the flagship example task (fresh installs only — gated
  // on "no provider yet" so existing DBs never get a duplicate Dream Journal).
  const count = db.select({ n: sql<number>`count(*)` }).from(schema.providers).get()!.n
  if (!count) {
    db.insert(schema.providers).values({
      name: 'claude -p',
      command: process.env.CLAUDE_BIN ?? 'claude',
      args_template: DEFAULT_CLAUDE_ARGS,
      loop_type: 'claude_print',
      is_default: 1,
    }).run()

    // Seed the Dream Journal as a daily task, due at the next idle window. A recurring
    // chain points origin_id at itself; status 'scheduled' + next_run_at <= now makes
    // the scheduler pick it up when the gate is open.
    const dj = db.insert(schema.tasks).values({
      description: DREAM_JOURNAL_PROMPT,
      schedule:    'daily',
      status:      'scheduled',
      next_run_at: new Date().toISOString(),
      timeout_s:   1800,
    }).returning().get()!
    db.update(schema.tasks).set({ origin_id: dj.id }).where(eq(schema.tasks.id, dj.id)).run()
  }

  // Seed builtin system prompt (once); keep its content current on upgrades.
  // The builtin row (is_builtin=1) is never user-edited — edits create new versions —
  // so refreshing it propagates protocol updates without touching custom prompts.
  const spCount = db.select({ n: sql<number>`count(*)` }).from(schema.systemPrompts).where(eq(schema.systemPrompts.is_builtin, 1)).get()!.n
  if (!spCount) {
    db.insert(schema.systemPrompts).values({
      version: 1, label: 'Built-in default', content: BUILTIN_SYSTEM_PROMPT, is_builtin: 1,
    }).run()
  } else {
    db.update(schema.systemPrompts).set({ content: BUILTIN_SYSTEM_PROMPT })
      .where(eq(schema.systemPrompts.is_builtin, 1)).run()
  }

  // Prune old snapshots
  db.delete(schema.usageSnapshots)
    .where(sql`${schema.usageSnapshots.recorded_at} < strftime('%Y-%m-%dT%H:%M:%SZ','now','-14 days')`)
    .run()
}

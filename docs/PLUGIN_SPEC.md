# restwalker Plugin Specification

version 0.1 — draft

---

## Overview

A restwalker plugin is a single JavaScript/TypeScript file (or npm package) that declares what it needs and what it does. The host provisions everything automatically — database tables, config UI, hook wiring — from those declarations.

A plugin has four parts:

```
schema   → tables the plugin needs (host creates/migrates SQLite)
config   → settings the user fills in (host renders form in Plugins panel)
register → hooks the plugin listens to (called at runtime)
meta     → name, description, version
```

---

## Plugin Shape

```typescript
import type { PluginDefinition } from 'restwalker/plugin'

const plugin: PluginDefinition = {
  meta: {
    name:        'my-plugin',
    description: 'What this plugin does',
    version:     '1.0.0',
  },

  schema: { /* table declarations */ },
  config: { /* config field declarations */ },

  register(ctx) {
    /* hook registrations */
  },
}

export default plugin
```

Every field except `meta` and `register` is optional. A plugin with only `register` and no `schema`/`config` is valid.

---

## 1. Meta

```typescript
meta: {
  name:        string   // unique identifier, kebab-case, no spaces
  description: string   // one-line description shown in the Plugins panel
  version:     string   // semver — used to track schema migrations
  author?:     string
  homepage?:   string
}
```

---

## 2. Schema

Declares SQLite tables the plugin needs. The host creates them on first load and migrates on version change.

```typescript
schema: {
  runs: {
    id:         { type: 'integer', pk: true },
    task_id:    { type: 'integer', nullable: false },
    result:     { type: 'text',    nullable: true  },
    created_at: { type: 'text',    nullable: false, default: "datetime('now')" },
  },
  tags: {
    id:      { type: 'integer', pk: true },
    run_id:  { type: 'integer', nullable: false, references: 'runs.id' },
    name:    { type: 'text',    nullable: false },
  },
}
```

### Column types

| type      | SQLite affinity | Notes                        |
|-----------|----------------|------------------------------|
| `integer` | INTEGER        | Use for pk, foreign keys     |
| `text`    | TEXT           | Default for strings          |
| `real`    | REAL           | Floating point               |
| `blob`    | BLOB           | Binary data                  |

### Column options

| option       | type    | description                                      |
|-------------|---------|--------------------------------------------------|
| `type`       | string  | required — one of the types above                |
| `pk`         | boolean | marks the primary key (auto-increment)           |
| `nullable`   | boolean | default `true`                                   |
| `default`    | string  | SQL expression string, e.g. `"datetime('now')"` |
| `references` | string  | foreign key as `"table.column"`                  |
| `unique`     | boolean | adds UNIQUE constraint                           |
| `index`      | boolean | adds an index on this column                     |

### Table naming

The host namespaces all tables as `plugin_<name>_<table>` to avoid conflicts.

A plugin declaring `schema.runs` with `meta.name = 'audit-log'` gets table `plugin_audit_log_runs`.

### Migrations

When a plugin's `version` changes, the host diffs the declared schema against the current table structure and applies `ALTER TABLE` statements for new columns. Dropping columns or changing types requires a manual migration hook (see [Advanced](#advanced)).

---

## 3. Config

Declares settings the user fills in once via the Plugins panel. The host renders the form, stores values in `~/.restwalker/plugins.json`, and passes the resolved object to `register()`.

```typescript
config: {
  apiKey: {
    type:        'string',
    label:       'API Key',
    placeholder: 'sk-...',
    sensitive:   true,
    required:    true,
  },
  baseUrl: {
    type:    'string',
    label:   'Base URL',
    default: 'https://api.example.com',
  },
  retries: {
    type:    'number',
    label:   'Retries',
    min:     0,
    max:     10,
    default: 3,
  },
  enabled: {
    type:    'boolean',
    label:   'Enable notifications',
    default: true,
  },
  mode: {
    type:    'enum',
    label:   'Mode',
    options: ['allow', 'block', 'warn'],
    default: 'warn',
  },
}
```

### Field types

| type      | rendered as                    |
|-----------|-------------------------------|
| `string`  | text input                    |
| `number`  | number input with min/max     |
| `boolean` | toggle                        |
| `enum`    | dropdown with `options` array |
| `text`    | multi-line textarea           |

### Field options

| option        | applies to       | description                             |
|--------------|------------------|-----------------------------------------|
| `label`       | all              | displayed above the input               |
| `placeholder` | string, text     | hint text inside the input              |
| `default`     | all              | value used when user hasn't set it      |
| `required`    | all              | shows validation error if empty         |
| `sensitive`   | string           | masked input, never logged              |
| `min` / `max` | number           | inclusive bounds                        |
| `options`     | enum             | array of allowed string values          |
| `hint`        | all              | small help text shown below the field   |

---

## 4. Register

`register(ctx)` is called once when the plugin loads. Use it to wire hook handlers.

```typescript
register(ctx: PluginContext): void
```

### PluginContext

```typescript
interface PluginContext {
  // Hook registration
  on(hook: 'pre_task',       handler: (e: PreTaskEvent)       => void | Promise<void>): void
  on(hook: 'post_task',      handler: (e: PostTaskEvent)      => void | Promise<void>): void
  on(hook: 'on_artifact',    handler: (e: ArtifactEvent)      => void | Promise<void>): void
  on(hook: 'on_idle',        handler: (e: IdleEvent)          => void | Promise<void>): void
  on(hook: 'on_turn',        handler: (e: TurnEvent)          => void | Promise<void>): void
  on(hook: 'on_tool_call',   handler: (e: ToolCallEvent)      => void | Promise<void>): void
  on(hook: 'on_tool_result', handler: (e: ToolResultEvent)    => void | Promise<void>): void
  on(hook: 'on_message',     handler: (e: MessageEvent)       => void | Promise<void>): void

  // Resolved config values (typed from your config declaration)
  config: Record<string, unknown>

  // Scoped database access (only your plugin's tables)
  db: PluginDb

  // Logger
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
}
```

### Hook event types

```typescript
// Fires before the agent runs. workspacePath is the task's working directory.
interface PreTaskEvent {
  task:          Task
  workspacePath: string
}

// Fires after the agent finishes.
interface PostTaskEvent {
  task:          Task
  workspacePath: string
  status:        'done' | 'failed'
  tokensUsed:    number
  toolCalls:     number
  result:        string
}

// Fires when the agent declares an output file as an artifact.
interface ArtifactEvent {
  task:        Task
  artifactPath: string
  description: string
  mimeType:    string
}

// Fires when the queue is idle (no tasks running or pending).
interface IdleEvent {
  reason: string
}

// Fires at the start of each agent turn (multi-turn sessions).
interface TurnEvent {
  task:        Task
  turn:        number
  inputTokens: number
}

// Fires when the agent is about to call a tool.
interface ToolCallEvent {
  task:   Task
  tool:   string
  input:  Record<string, unknown>
  callId: string
}

// Fires when a tool returns its result.
interface ToolResultEvent {
  task:    Task
  tool:    string
  callId:  string
  result:  string
  isError: boolean
}

// Fires when the agent emits a text message.
interface MessageEvent {
  task:      Task
  content:   string
  thinking?: string
}
```

### PluginDb

Scoped database access. Only your plugin's declared tables are accessible.

```typescript
interface PluginDb {
  // Insert a row. Returns the inserted row's id.
  insert(table: string, row: Record<string, unknown>): number

  // Query rows. Returns an array of objects.
  query(table: string, where?: Record<string, unknown>): Record<string, unknown>[]

  // Run raw SQL scoped to your plugin's tables.
  // Table names are automatically prefixed — use bare names from your schema.
  sql(query: string, params?: unknown[]): Record<string, unknown>[]
}
```

---

## 5. Full Example

A plugin that logs every task completion to its own SQLite table and posts to Slack.

```typescript
import type { PluginDefinition } from 'restwalker/plugin'

const plugin: PluginDefinition = {
  meta: {
    name:        'slack-notify',
    description: 'Post task results to a Slack channel',
    version:     '1.0.0',
  },

  schema: {
    posts: {
      id:         { type: 'integer', pk: true },
      task_id:    { type: 'integer', nullable: false, index: true },
      status:     { type: 'text',    nullable: false },
      posted_at:  { type: 'text',    nullable: false, default: "datetime('now')" },
      slack_ts:   { type: 'text',    nullable: true },
    },
  },

  config: {
    webhookUrl: {
      type:      'string',
      label:     'Slack Webhook URL',
      sensitive: true,
      required:  true,
    },
    channel: {
      type:        'string',
      label:       'Channel',
      placeholder: '#builds',
      default:     '#general',
    },
    onlyOnFailure: {
      type:    'boolean',
      label:   'Only notify on failure',
      default: false,
    },
  },

  register(ctx) {
    ctx.on('post_task', async ({ task, status }) => {
      if (ctx.config.onlyOnFailure && status !== 'failed') return

      const body = {
        channel: ctx.config.channel,
        text:    `Task #${task.id} ${status}: ${task.description.slice(0, 80)}`,
      }

      const res = await fetch(ctx.config.webhookUrl as string, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })

      ctx.db.insert('posts', {
        task_id:   task.id,
        status,
        slack_ts:  res.ok ? (await res.json()).ts : null,
      })

      if (!res.ok) ctx.log.warn(`Slack post failed: ${res.status}`)
    })
  },
}

export default plugin
```

---

## 6. Package Format

A plugin can be a single file or an npm package.

**Single file:**
```
my-plugin.ts   (or .js)
```

**npm package:**
```
package.json          ← main or exports['.'] points to the entry
restwalker.plugin.json  ← optional manifest for discovery metadata
src/index.ts
```

### restwalker.plugin.json

Optional manifest for plugin registries and the Plugins panel display.

```json
{
  "id":          "slack-notify",
  "name":        "Slack Notify",
  "description": "Post task results to a Slack channel",
  "version":     "1.0.0",
  "author":      "Your Name",
  "keywords":    ["slack", "notifications"],
  "homepage":    "https://github.com/you/restwalker-slack-notify"
}
```

---

## 7. Installation

**From a local file:**
```
POST /plugins/install
{ "path": "/path/to/my-plugin.js" }
```

**From npm (coming soon):**
```
POST /plugins/install
{ "package": "restwalker-plugin-slack-notify" }
```

On install, the host:
1. Loads the plugin file and validates its shape
2. Creates or migrates any declared `schema` tables
3. Registers the plugin in `~/.restwalker/plugins.json`
4. Calls `register(ctx)` with the resolved config and scoped db

---

## Advanced

### Manual migrations

When a schema change requires more than adding columns (e.g. renaming, type changes, backfills), export a `migrations` array:

```typescript
migrations: [
  {
    version: '1.1.0',
    up(db: RawDb) {
      db.exec('ALTER TABLE plugin_slack_notify_posts RENAME COLUMN ts TO slack_ts')
    },
  },
]
```

Migrations run in version order before `register()` is called.

### Accessing the host Task type

```typescript
import type { Task } from 'restwalker/types'
```

---

## What the host guarantees

- Plugin tables are namespaced — no two plugins can collide
- `ctx.db` is scoped — a plugin cannot read another plugin's tables via the `db` helper (raw SQL can, by design)
- `ctx.config` is validated against the plugin's `config` declaration before `register()` is called — missing required fields surface as errors in the Plugins panel, not crashes
- Hook errors are caught per-plugin — one plugin throwing does not block others
- Migrations run before `register()` — the db is always at the declared schema when hooks fire

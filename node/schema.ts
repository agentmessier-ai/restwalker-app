import { sqliteTable, integer, text, real } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

const NOW = sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))`

export const usageSnapshots = sqliteTable('usage_snapshots', {
  id:              integer('id').primaryKey({ autoIncrement: true }),
  five_hour_pct:   real('five_hour_pct').notNull(),
  weekly_pct:      real('weekly_pct').notNull(),
  weekly_resets_at:text('weekly_resets_at'),
  recorded_at:     text('recorded_at').notNull().default(NOW),
})

export const settings = sqliteTable('settings', {
  key:        text('key').primaryKey(),
  value:      text('value').notNull(),
  updated_at: text('updated_at').notNull().default(NOW),
})

export const providers = sqliteTable('providers', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  name:         text('name').notNull(),
  command:      text('command').notNull(),
  args_template:text('args_template').notNull().default('[]'),
  is_default:   integer('is_default').notNull().default(0),
  loop_type:    text('loop_type').notNull().default('claude_print'),
  created_at:   text('created_at').notNull().default(NOW),
})

export const systemPrompts = sqliteTable('system_prompts', {
  id:         integer('id').primaryKey({ autoIncrement: true }),
  version:    integer('version').notNull(),
  label:      text('label').notNull().default(''),
  content:    text('content').notNull(),
  is_builtin: integer('is_builtin').notNull().default(0),
  created_at: text('created_at').notNull().default(NOW),
})

export const artifacts = sqliteTable('artifacts', {
  id:          integer('id').primaryKey({ autoIncrement: true }),
  task_id:     integer('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  path:        text('path').notNull(),
  description: text('description').notNull().default(''),
  mime_type:   text('mime_type').notNull().default('text/plain'),
  size:        integer('size').notNull().default(0),
  created_at:  text('created_at').notNull().default(NOW),
})

export const tasks = sqliteTable('tasks', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  origin_id:     integer('origin_id'),          // first task id in a recurring chain
  description:   text('description').notNull(),
  cwd:           text('cwd').notNull().default(''),
  model:         text('model').notNull().default('claude-sonnet-4-6'),
  provider_id:   integer('provider_id').references(() => providers.id),
  schedule:      text('schedule').notNull().default('once'),
  next_run_at:   text('next_run_at'),
  status:        text('status').notNull().default('pending'),
  result:        text('result'),
  workspace_path:text('workspace_path'),
  session_id:    text('session_id'),
  session_path:  text('session_path'),
  tool_calls:    integer('tool_calls').notNull().default(0),
  tokens_used:   integer('tokens_used').notNull().default(0),
  created_at:    text('created_at').notNull().default(NOW),
  started_at:    text('started_at'),
  finished_at:   text('finished_at'),
  prompt_id:     integer('prompt_id'),
  webhook_pre_url:    text('webhook_pre_url'),
  webhook_post_url:   text('webhook_post_url'),
  webhook_timeout_s:  integer('webhook_timeout_s').notNull().default(10),
  webhook_retry:      integer('webhook_retry').notNull().default(2),
  webhook_ignore_ssl: integer('webhook_ignore_ssl').notNull().default(0),
  // per-task agent timeout in seconds; null = use the global TASK_TIMEOUT_S setting
  timeout_s:          integer('timeout_s'),
  // agent-assigned topic tags, stored as a JSON string array (e.g. '["backend","refactor"]')
  tags:               text('tags'),
})

export const taskPrompts = sqliteTable('task_prompts', {
  id:          integer('id').primaryKey({ autoIncrement: true }),
  origin_id:   integer('origin_id').notNull(),
  version:     integer('version').notNull(),
  title:       text('title').notNull().default(''),
  content:     text('content').notNull(),
  cwd:         text('cwd').notNull().default(''),
  model:       text('model').notNull().default('claude-sonnet-4-6'),
  provider_id: integer('provider_id'),
  schedule:    text('schedule').notNull().default('once'),
  created_at:  text('created_at').notNull().default(NOW),
})

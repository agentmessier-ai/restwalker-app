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
  created_at:   text('created_at').notNull().default(NOW),
})

export const tasks = sqliteTable('tasks', {
  id:          integer('id').primaryKey({ autoIncrement: true }),
  description: text('description').notNull(),
  cwd:         text('cwd').notNull().default(''),
  model:       text('model').notNull().default('claude-sonnet-4-6'),
  provider_id: integer('provider_id').references(() => providers.id),
  schedule:    text('schedule').notNull().default('once'),
  next_run_at: text('next_run_at'),
  status:      text('status').notNull().default('pending'),
  result:      text('result'),
  session_id:  text('session_id'),
  session_path:text('session_path'),
  tool_calls:  integer('tool_calls').notNull().default(0),
  tokens_used: integer('tokens_used').notNull().default(0),
  created_at:  text('created_at').notNull().default(NOW),
  started_at:  text('started_at'),
  finished_at: text('finished_at'),
})

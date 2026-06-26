import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import * as schema from '../schema.js'

// ── Bootstrap ──────────────────────────────────────────────────────────────────

export const DATA_DIR = join(homedir(), '.restwalker')
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

export const WORKSPACE_DIR = join(DATA_DIR, 'workspace')
if (!existsSync(WORKSPACE_DIR)) mkdirSync(WORKSPACE_DIR, { recursive: true })

const DB_PATH = process.env.RESTWALKER_DB ?? join(DATA_DIR, 'restwalker.db')

export const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

export const client = new Database(DB_PATH)
client.pragma('journal_mode = WAL')

export const db = drizzle(client, { schema })

export { schema }

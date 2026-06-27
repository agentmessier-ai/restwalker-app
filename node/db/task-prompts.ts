import { eq, desc, sql } from 'drizzle-orm'
import { db, schema } from './client.js'
import type { TaskSchedule } from './tasks.js'

// ── Types ──────────────────────────────────────────────────────────────────────

export type TaskPrompt = typeof schema.taskPrompts.$inferSelect

// ── Internal helpers ───────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-6'

// ── Task Prompts repository ────────────────────────────────────────────────────

export function createTaskPrompt(
  content: string,
  opts?: { title?: string; cwd?: string; model?: string; providerId?: number | null; schedule?: TaskSchedule },
): TaskPrompt {
  // Insert with placeholder origin_id=0, then update to self.id
  const row = db.insert(schema.taskPrompts).values({
    origin_id:   0,
    version:     1,
    title:       opts?.title ?? '',
    content,
    cwd:         opts?.cwd ?? '',
    model:       opts?.model ?? DEFAULT_MODEL,
    provider_id: opts?.providerId ?? null,
    schedule:    opts?.schedule ?? 'once',
  }).returning().get()!
  db.update(schema.taskPrompts).set({ origin_id: row.id }).where(eq(schema.taskPrompts.id, row.id)).run()
  return { ...row, origin_id: row.id }
}

export function saveTaskPromptVersion(
  originId: number,
  content: string,
  opts?: { title?: string; cwd?: string; model?: string; providerId?: number | null; schedule?: TaskSchedule },
): TaskPrompt {
  const maxRow = db.select({ v: sql<number>`max(version)` })
    .from(schema.taskPrompts)
    .where(eq(schema.taskPrompts.origin_id, originId))
    .get()
  const nextVersion = (maxRow?.v ?? 0) + 1
  return db.insert(schema.taskPrompts).values({
    origin_id:   originId,
    version:     nextVersion,
    title:       opts?.title ?? '',
    content,
    cwd:         opts?.cwd ?? '',
    model:       opts?.model ?? DEFAULT_MODEL,
    provider_id: opts?.providerId ?? null,
    schedule:    opts?.schedule ?? 'once',
  }).returning().get()!
}

export function getTaskPromptVersions(originId: number): TaskPrompt[] {
  return db.select().from(schema.taskPrompts)
    .where(eq(schema.taskPrompts.origin_id, originId))
    .orderBy(desc(schema.taskPrompts.version))
    .all()
}

export function getLatestTaskPrompt(originId: number): TaskPrompt | null {
  return db.select().from(schema.taskPrompts)
    .where(eq(schema.taskPrompts.origin_id, originId))
    .orderBy(desc(schema.taskPrompts.version))
    .limit(1)
    .get() ?? null
}

export function getTaskPrompt(id: number): TaskPrompt | null {
  return db.select().from(schema.taskPrompts)
    .where(eq(schema.taskPrompts.id, id))
    .get() ?? null
}

import { eq, asc } from 'drizzle-orm'
import { db, schema } from './client.js'
import { lookup as mimeLookup } from '../mime.js'
import { statSync } from 'fs'

// ── Types ──────────────────────────────────────────────────────────────────────

export type Artifact = typeof schema.artifacts.$inferSelect

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

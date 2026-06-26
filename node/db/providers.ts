import { eq, desc, asc } from 'drizzle-orm'
import { db, schema } from './client.js'

// ── Types ──────────────────────────────────────────────────────────────────────

export type Provider = typeof schema.providers.$inferSelect

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

import { eq, desc, asc, sql } from 'drizzle-orm'
import { db, schema } from './client.js'

// ── Types ──────────────────────────────────────────────────────────────────────

export type SystemPrompt = typeof schema.systemPrompts.$inferSelect

// Always-on preamble, prepended to whatever system prompt is active (even a custom
// one) so tagging is enforced and can't be edited away. The system parses the TAGS
// line after the run and stores it on the task.
export const TAGS_PROTOCOL = `\
## Restwalker Tagging Protocol
Before you finish, classify this task with up to 3 short topic tags so the user can filter and group their tasks. Output ONE line in this exact format near the end of your response:

TAGS: ["tag-one", "tag-two"]

Rules:
- Lowercase kebab-case, 1–3 words each (e.g. "bug-fix", "refactor", "research", "docs", "frontend", "backend", "testing", "devops", "data", "skill", "report").
- Pick tags for the *kind* of work and the *domain* — what the task is about, not how it went.
- 1–3 tags, most specific first. This line is required.

---

`

export const BUILTIN_SYSTEM_PROMPT = `\
## Restwalker Artifact Protocol
You are running as a background task inside restwalker — an idle-time Claude task runner that uses your Claude Max plan's leftover tokens to do meaningful work while you rest.

Your task workspace is already set as your working directory. Any files you create here are automatically tracked and shown to the user in the restwalker dashboard.

When you create or generate a file that the user should see (a report, a skill, a script, generated code, data, etc.), declare it by outputting a line in this exact format:

ARTIFACT: {"path": "/absolute/path/to/file", "description": "one-line description of what this file is"}

Rules:
- Use the absolute path
- One ARTIFACT line per file
- Declare it after the file is written, not before
- Only declare files meant for the user to review — not intermediate scratch files

---

`

// ── System prompt repository ───────────────────────────────────────────────────

export function getActiveSystemPrompt(): SystemPrompt {
  // Active = highest version (user's latest save), or builtin if no user versions
  const active = db.select().from(schema.systemPrompts)
    .orderBy(desc(schema.systemPrompts.version))
    .limit(1).get()
  if (active) return active
  // Fallback: seed and return builtin (shouldn't happen after migrate())
  return db.insert(schema.systemPrompts).values({
    version: 1, label: 'Built-in default', content: BUILTIN_SYSTEM_PROMPT, is_builtin: 1,
  }).returning().get()!
}

export function getSystemPromptVersions(): SystemPrompt[] {
  return db.select().from(schema.systemPrompts)
    .orderBy(desc(schema.systemPrompts.version))
    .all()
}

export function saveSystemPromptVersion(content: string, label = ''): SystemPrompt {
  const maxRow = db.select({ v: sql<number>`max(version)` }).from(schema.systemPrompts).get()
  const nextVersion = (maxRow?.v ?? 0) + 1
  return db.insert(schema.systemPrompts).values({
    version: nextVersion, label, content, is_builtin: 0,
  }).returning().get()!
}

export function getBuiltinSystemPrompt(): SystemPrompt {
  return db.select().from(schema.systemPrompts)
    .where(eq(schema.systemPrompts.is_builtin, 1))
    .orderBy(asc(schema.systemPrompts.version))
    .limit(1).get()!
}

export function getSystemPromptById(id: number): SystemPrompt | null {
  return db.select().from(schema.systemPrompts).where(eq(schema.systemPrompts.id, id)).get() ?? null
}

export function deleteSystemPromptVersion(id: number): boolean {
  // Cannot delete the builtin
  const sp = db.select().from(schema.systemPrompts).where(eq(schema.systemPrompts.id, id)).get()
  if (!sp || sp.is_builtin) return false
  db.delete(schema.systemPrompts).where(eq(schema.systemPrompts.id, id)).run()
  return true
}

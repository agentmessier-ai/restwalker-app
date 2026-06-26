import { eq, desc, asc, sql, and, lte, inArray } from 'drizzle-orm'
import { db, client, schema } from './client.js'
import { getTaskPrompt, getLatestTaskPrompt } from './task-prompts.js'

// ── Types ──────────────────────────────────────────────────────────────────────

export type Task         = typeof schema.tasks.$inferSelect
export type TaskStatus   = 'scheduled' | 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
export type TaskSchedule = 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly'

// ── Internal helpers ───────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-6'

function computeNextRun(schedule: TaskSchedule): string {
  const d = new Date()
  if (schedule === 'hourly')  return new Date(d.getTime() + 3_600_000).toISOString()
  if (schedule === 'daily')   return new Date(d.getTime() + 86_400_000).toISOString()
  if (schedule === 'weekly')  return new Date(d.getTime() + 7 * 86_400_000).toISOString()
  if (schedule === 'monthly') { d.setMonth(d.getMonth() + 1); return d.toISOString() }
  return d.toISOString()
}

// ── Tasks repository ───────────────────────────────────────────────────────────

export function addTask(
  description: string, cwd = '', model = DEFAULT_MODEL,
  providerId?: number | null, schedule: TaskSchedule = 'once',
  opts?: {
    promptId?: number
    webhookPreUrl?: string | null
    webhookPostUrl?: string | null
    webhookTimeoutS?: number
    webhookRetry?: number
    webhookIgnoreSsl?: number
    timeoutS?: number | null
  },
): Task {
  const task = db.insert(schema.tasks).values({
    description,
    cwd: cwd || '',
    model: model || DEFAULT_MODEL,
    provider_id: providerId ?? null,
    schedule,
    prompt_id: opts?.promptId ?? null,
    webhook_pre_url:    opts?.webhookPreUrl    ?? null,
    webhook_post_url:   opts?.webhookPostUrl   ?? null,
    webhook_timeout_s:  opts?.webhookTimeoutS  ?? 10,
    webhook_retry:      opts?.webhookRetry     ?? 2,
    webhook_ignore_ssl: opts?.webhookIgnoreSsl ?? 0,
    timeout_s:          opts?.timeoutS         ?? null,
  }).returning().get()!
  // For recurring tasks, set origin_id to self on first creation
  if (schedule !== 'once') {
    db.update(schema.tasks).set({ origin_id: task.id }).where(eq(schema.tasks.id, task.id)).run()
    return { ...task, origin_id: task.id }
  }
  return task
}

export function createNextRun(task: Task): Task | null {
  if (!task.schedule || task.schedule === 'once') return null
  const originId = task.origin_id ?? task.id

  // If task is linked to a prompt, use the latest version of that prompt
  let description = task.description
  let cwd         = task.cwd
  let model       = task.model
  let provider_id = task.provider_id
  let schedule    = task.schedule
  let prompt_id: number | null = task.prompt_id ?? null

  if (task.prompt_id) {
    const prompt = getTaskPrompt(task.prompt_id)
    if (prompt) {
      const latest = getLatestTaskPrompt(prompt.origin_id)
      if (latest) {
        description = latest.content
        cwd         = latest.cwd
        model       = latest.model
        provider_id = latest.provider_id ?? null
        schedule    = latest.schedule as TaskSchedule
        prompt_id   = latest.id
      }
    }
  }

  return db.insert(schema.tasks).values({
    origin_id:   originId,
    description,
    cwd,
    model,
    provider_id,
    schedule,
    status:      'scheduled',
    next_run_at: computeNextRun(schedule as TaskSchedule),
    prompt_id,
    webhook_pre_url:    task.webhook_pre_url    ?? null,
    webhook_post_url:   task.webhook_post_url   ?? null,
    webhook_timeout_s:  task.webhook_timeout_s  ?? 10,
    webhook_retry:      task.webhook_retry      ?? 2,
    webhook_ignore_ssl: task.webhook_ignore_ssl ?? 0,
    timeout_s:          task.timeout_s          ?? null,
  }).returning().get()!
}

function createNextRunInTx(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], task: Task): Task | null {
  if (!task.schedule || task.schedule === 'once') return null
  const originId = task.origin_id ?? task.id

  let description = task.description
  let cwd         = task.cwd
  let model       = task.model
  let provider_id = task.provider_id
  let schedule    = task.schedule
  let prompt_id: number | null = task.prompt_id ?? null

  if (task.prompt_id) {
    const prompt = getTaskPrompt(task.prompt_id)
    if (prompt) {
      const latest = getLatestTaskPrompt(prompt.origin_id)
      if (latest) {
        description = latest.content
        cwd         = latest.cwd
        model       = latest.model
        provider_id = latest.provider_id ?? null
        schedule    = latest.schedule as TaskSchedule
        prompt_id   = latest.id
      }
    }
  }

  return tx.insert(schema.tasks).values({
    origin_id:   originId,
    description,
    cwd,
    model,
    provider_id,
    schedule,
    status:      'scheduled',
    next_run_at: computeNextRun(schedule as TaskSchedule),
    prompt_id,
    webhook_pre_url:    task.webhook_pre_url    ?? null,
    webhook_post_url:   task.webhook_post_url   ?? null,
    webhook_timeout_s:  task.webhook_timeout_s  ?? 10,
    webhook_retry:      task.webhook_retry      ?? 2,
    webhook_ignore_ssl: task.webhook_ignore_ssl ?? 0,
    timeout_s:          task.timeout_s          ?? null,
  }).returning().get()!
}

export function completeTask(
  taskId: number,
  opts: {
    result: string
    session_id?: string
    session_path?: string
    tool_calls?: number
    tokens_used?: number
    workspace_path?: string
  }
): { task: Task; next: Task | null } {
  return db.transaction((tx) => {
    const now = new Date().toISOString()
    tx.update(schema.tasks)
      .set({
        status:         'done',
        result:         opts.result,
        session_id:     opts.session_id ?? null,
        session_path:   opts.session_path ?? null,
        tool_calls:     opts.tool_calls ?? 0,
        tokens_used:    opts.tokens_used ?? 0,
        workspace_path: opts.workspace_path ?? null,
        finished_at:    now,
      })
      .where(eq(schema.tasks.id, taskId))
      .run()

    const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get() as Task
    const next = task.schedule !== 'once' ? createNextRunInTx(tx, task) : null
    return { task, next }
  })
}

// All distinct recurring task chains (one representative + run count per chain)
export function getRecurringGroups(): { origin: Task; runs: Task[] }[] {
  const all = db.select().from(schema.tasks)
    .where(sql`schedule != 'once'`)
    .orderBy(desc(schema.tasks.id))
    .all()
  const groups = new Map<number, Task[]>()
  for (const t of all) {
    const key = t.origin_id ?? t.id
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(t)
  }
  return Array.from(groups.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([, runs]) => ({
      origin: runs.find(r => r.status === 'scheduled') ?? runs[0],
      runs:   runs.filter(r => r.status !== 'scheduled'),
    }))
}

export function getRunsByOrigin(originId: number): Task[] {
  return db.select().from(schema.tasks)
    .where(and(
      eq(schema.tasks.origin_id, originId),
      sql`schedule != 'once'`,
    ))
    .orderBy(desc(schema.tasks.id))
    .all()
}

export function getScheduledDueTasks(): Task[] {
  return db.select().from(schema.tasks)
    .where(and(
      eq(schema.tasks.status, 'scheduled'),
      lte(schema.tasks.next_run_at, sql`strftime('%Y-%m-%dT%H:%M:%SZ','now')`),
    ))
    .all()
}

export function getTasks(limit = 25, offset = 0, opts?: {
  status?: TaskStatus
  scheduleType?: 'once' | 'recurring'
  sort?: 'created' | 'finished' | 'duration'
  dir?: 'asc' | 'desc'
}): Task[] {
  const { status, scheduleType, sort = 'created', dir = 'desc' } = opts ?? {}
  const orderFn = dir === 'asc' ? asc : desc
  const orderExpr = sort === 'finished'
    ? orderFn(schema.tasks.finished_at)
    : sort === 'duration'
    ? orderFn(sql`(unixepoch(finished_at) - unixepoch(started_at))`)
    : orderFn(schema.tasks.id)

  const conditions = []
  if (status)       conditions.push(eq(schema.tasks.status, status))
  if (scheduleType === 'once')      conditions.push(eq(schema.tasks.schedule, 'once'))
  if (scheduleType === 'recurring') conditions.push(sql`schedule != 'once'`)

  const where = conditions.length ? and(...conditions) : undefined
  return (where
    ? db.select().from(schema.tasks).where(where)
    : db.select().from(schema.tasks)
  ).orderBy(orderExpr).limit(limit).offset(offset).all()
}

export function getTaskCount(status?: TaskStatus, scheduleType?: 'once' | 'recurring'): number {
  const conditions = []
  if (status)       conditions.push(eq(schema.tasks.status, status))
  if (scheduleType === 'once')      conditions.push(eq(schema.tasks.schedule, 'once'))
  if (scheduleType === 'recurring') conditions.push(sql`schedule != 'once'`)
  const where = conditions.length ? and(...conditions) : undefined
  return (where
    ? db.select({ n: sql<number>`count(*)` }).from(schema.tasks).where(where)
    : db.select({ n: sql<number>`count(*)` }).from(schema.tasks)
  ).get()!.n
}

export function getTask(id: number): Task | null {
  return db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get() ?? null
}

export function setTaskPending(id: number): void {
  db.update(schema.tasks)
    .set({ status: 'pending', next_run_at: null })
    .where(eq(schema.tasks.id, id))
    .run()
}

export function setTaskRunning(id: number): void {
  db.update(schema.tasks)
    .set({ status: 'running', started_at: sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))` as unknown as string })
    .where(eq(schema.tasks.id, id))
    .run()
}

export function setTaskDone(id: number, updates: {
  result?: string; session_id?: string; session_path?: string
  tool_calls?: number; tokens_used?: number; workspace_path?: string
}): void {
  const NOW_SQL = sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))` as unknown as string
  const set: Partial<typeof schema.tasks.$inferInsert> = {
    status:      'done',
    finished_at: NOW_SQL,
  }
  if (updates.result         !== undefined) set.result         = updates.result
  if (updates.session_id     !== undefined) set.session_id     = updates.session_id
  if (updates.session_path   !== undefined) set.session_path   = updates.session_path
  if (updates.tool_calls     !== undefined) set.tool_calls     = updates.tool_calls
  if (updates.tokens_used    !== undefined) set.tokens_used    = updates.tokens_used
  if (updates.workspace_path !== undefined) set.workspace_path = updates.workspace_path
  db.update(schema.tasks).set(set).where(eq(schema.tasks.id, id)).run()
}

export function setTaskFailed(id: number, error: string): { task: Task; next: Task | null } {
  return db.transaction((tx) => {
    const now = new Date().toISOString()
    tx.update(schema.tasks)
      .set({ status: 'failed', result: error, finished_at: now })
      .where(eq(schema.tasks.id, id))
      .run()
    const task = tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get() as Task
    // A failed run must not break a recurring chain — schedule the next occurrence
    // so one transient failure (timeout, flaky network) doesn't kill a daily task.
    const next = task.schedule !== 'once' ? createNextRunInTx(tx, task) : null
    return { task, next }
  })
}

export function cancelTask(id: number): void {
  db.update(schema.tasks)
    .set({ status: 'cancelled' })
    .where(and(
      eq(schema.tasks.id, id),
      inArray(schema.tasks.status, ['pending', 'scheduled']),
    ))
    .run()
}

export function deleteTask(id: number): boolean {
  const result = db.delete(schema.tasks)
    .where(and(
      eq(schema.tasks.id, id),
      inArray(schema.tasks.status, ['pending', 'scheduled', 'done', 'failed', 'cancelled']),
    ))
    .run()
  return result.changes > 0
}

export function resetOrphanedTasks(): number {
  const result = db
    .update(schema.tasks)
    .set({ status: 'pending', started_at: null })
    .where(eq(schema.tasks.status, 'running'))
    .run()
  return result.changes
}

export function queueStats(): { scheduled: number; pending: number; running: number; done: number; failed: number; total: number } {
  // Conditional aggregation kept as raw SQL for readability
  const row = client.prepare(`
    SELECT
      SUM(CASE WHEN status='scheduled' THEN 1 ELSE 0 END) AS scheduled,
      SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='running'   THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status='done'      THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN status='failed'    THEN 1 ELSE 0 END) AS failed,
      COUNT(*)                                             AS total
    FROM tasks
  `).get() as { scheduled: number; pending: number; running: number; done: number; failed: number; total: number }
  return row
}

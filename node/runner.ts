import Queue from 'better-queue'
import { createRequire } from 'module'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync, existsSync } from 'fs'
import * as db from './db.js'
import * as scheduler from './scheduler.js'
import { plugins } from './plugins.js'
import * as gbrain from './gbrain.js'
import type { AgentLoopContext, AgentLoopResult, LoopType } from './agent-loop.js'
import { createLoop } from './loops/index.js'

let _log: { info: (s: string) => void; warn: (s: string) => void } = { info: console.log, warn: console.warn }
export function setLogger(l: typeof _log) { _log = l }

// ── Workspace path builder ─────────────────────────────────────────────────────

function buildWorkspacePath(task: db.Task): string {
  const slug = task.description
    .split('\n')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  if (task.schedule !== 'once') {
    const originId = task.origin_id ?? task.id
    const base = join(db.WORKSPACE_DIR, `${originId}-${slug}`)
    return join(base, ts)
  }
  return join(db.WORKSPACE_DIR, `${task.id}-${slug}-${ts}`)
}

// ── Artifact saver ─────────────────────────────────────────────────────────────

async function saveArtifactsForTask(task: db.Task, decls: { path: string; description: string }[]): Promise<void> {
  try {
    const saved = db.saveArtifacts(task.id, decls)
    _log.info(`[queue] task #${task.id} saved ${saved.length} artifact(s)`)
    for (const a of saved) {
      await plugins.invoke('on_artifact', {
        task,
        artifactPath: a.path,
        description: a.description,
        mimeType: a.mime_type ?? 'text/plain',
      })
    }
  } catch (e) {
    _log.warn(`[queue] artifact save error: ${(e as Error).message}`)
  }
}

// ── Queue setup ────────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url)
const SqliteStore = require('better-queue-sqlite')

const QUEUE_DB        = join(homedir(), '.restwalker', 'queue.db')
const POLL_MS         = parseInt(process.env.QUEUE_POLL_MS    ?? '120000')
// Read at task-run time from DB settings so changes take effect without restart
function getTaskTimeoutMs(): number {
  return parseInt(db.getSettings().TASK_TIMEOUT_MS ?? '600000')
}

interface QueuePayload {
  id: string     // better-queue uses this as the task key
  taskId: number
  description: string
  cwd: string
}

async function gateOpen(): Promise<boolean> {
  try {
    const cfg    = db.getSettings()
    const staleS = parseFloat(cfg.CACHE_STALE_MIN) * 60
    const usage  = await scheduler.readUsage({ cacheStaleS: staleS })
    const result = await scheduler.canRun(usage, cfg)
    if (!result.ok) _log.info(`[queue] gate: ${result.reason}`)
    return result.ok
  } catch (e) {
    _log.warn('[queue] gate check error: ' + (e as Error).message)
    return false
  }
}

// ── Main task processor ────────────────────────────────────────────────────────

async function processTask(input: QueuePayload): Promise<void> {
  const task = db.getTask(input.taskId)
  if (!task || task.status === 'cancelled') return

  _log.info(`[queue] starting task #${task.id}: ${task.description.slice(0, 80)}`)

  const workspacePath = buildWorkspacePath(task)
  if (!existsSync(workspacePath)) mkdirSync(workspacePath, { recursive: true })

  await plugins.invoke('pre_task', { task, workspacePath })

  db.setTaskRunning(task.id)

  let enrichment: string | null = null
  if (process.env.GBRAIN_URL) {
    enrichment = await gbrain.enrichTaskPrompt(task.description)
  }

  const provider = task.provider_id
    ? db.getProvider(task.provider_id)
    : db.getDefaultProvider()
  if (!provider) {
    const errMsg = 'no agent provider configured'
    db.setTaskFailed(task.id, errMsg)
    await plugins.invoke('post_task', { task, workspacePath, status: 'failed', tokensUsed: 0, toolCalls: 0, result: errMsg })
    return
  }

  const loopType = (provider.loop_type ?? 'claude_print') as LoopType
  const loop = createLoop(loopType, getTaskTimeoutMs())

  const loopCtx: AgentLoopContext = {
    task,
    workspacePath,
    systemPrompt: db.getActiveSystemPrompt().content,
    model: task.model || 'claude-sonnet-4-6',
    extraContext: enrichment ?? undefined,
    cwd: task.cwd || workspacePath,
  }

  let loopResult: AgentLoopResult

  try {
    loopResult = await loop.run(loopCtx, async (event) => {
      if (event.type === 'turn_start') {
        await plugins.invoke('on_turn', { task, turn: event.turn, inputTokens: event.inputTokens })
      } else if (event.type === 'tool_call') {
        await plugins.invoke('on_tool_call', { task, tool: event.tool, input: event.input, callId: event.callId })
      } else if (event.type === 'tool_result') {
        await plugins.invoke('on_tool_result', { task, tool: event.tool, callId: event.callId, result: event.result, isError: event.isError })
      } else if (event.type === 'message') {
        await plugins.invoke('on_message', { task, content: event.content, thinking: event.thinking })
      }
      // 'artifact' events are handled after loop completes (saveArtifactsForTask)
    })
  } catch (e) {
    const errMsg = (e as Error).message
    db.setTaskFailed(task.id, errMsg)
    await plugins.invoke('post_task', { task, workspacePath, status: 'failed', tokensUsed: 0, toolCalls: 0, result: errMsg })
    return
  }

  _log.info(`[queue] task #${task.id} completed`)

  const { next } = db.completeTask(task.id, {
    result:         loopResult.result,
    session_id:     loopResult.sessionId ?? undefined,
    session_path:   loopResult.sessionPath ?? undefined,
    tool_calls:     loopResult.toolCalls,
    tokens_used:    loopResult.tokensUsed,
    workspace_path: workspacePath,
  })

  await plugins.invoke('post_task', { task, workspacePath, status: 'done', tokensUsed: loopResult.tokensUsed, toolCalls: loopResult.toolCalls, result: loopResult.result })
  if (loopResult.artifacts.length) await saveArtifactsForTask(task, loopResult.artifacts)
  if (next) _log.info(`[queue] next run of #${task.id} scheduled as #${next.id} at ${next.next_run_at}`)
}

// ── Queue management ───────────────────────────────────────────────────────────

export function startQueue(log: (msg: string) => void): Queue<QueuePayload, void> {
  const queue = new Queue<QueuePayload, void>(
    (input, cb) => {
      processTask(input).then(() => cb(null)).catch(cb)
    },
    {
      store: new SqliteStore({ path: QUEUE_DB }),
      concurrent: 1,
      precondition: (cb: (err: null, ready: boolean) => void) => {
        gateOpen().then(ok => cb(null, ok)).catch(() => cb(null, false))
      },
      preconditionRetryTimeout: POLL_MS,
    }
  )

  queue.on('task_failed', (taskId: string, err: Error) => {
    log(`[queue] task ${taskId} failed: ${err?.message ?? err}`)
  })

  log('[queue] runner started')
  return queue
}

export function enqueueTask(task: db.Task): void {
  const q = getQueue()
  if (!q) throw new Error('queue not started')
  q.push({ id: String(task.id), taskId: task.id, description: task.description, cwd: task.cwd })
}

let _queue: Queue<QueuePayload, void> | null = null
export function setQueue(q: Queue<QueuePayload, void>) { _queue = q }
export function getQueue() { return _queue }

let _forceRunning = false

export async function forceRunTask(taskId: number, log: (msg: string) => void): Promise<{ ok: boolean; error?: string }> {
  if (_forceRunning) return { ok: false, error: 'already running a forced task' }
  const task = db.getTask(taskId)
  if (!task) return { ok: false, error: 'task not found' }
  if (task.status !== 'pending') return { ok: false, error: `task is ${task.status}, not pending` }
  _forceRunning = true
  log(`[queue] force-running task #${task.id}`)
  try {
    await processTask({ id: String(task.id), taskId: task.id, description: task.description, cwd: task.cwd })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    _forceRunning = false
  }
}

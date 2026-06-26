import Queue from 'better-queue'
import { createRequire } from 'module'
import { spawn } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync, existsSync } from 'fs'
import * as db from './db.js'
import * as scheduler from './scheduler.js'
import { findSessionJsonl, analyzeSession } from './session.js'
import { plugins } from './plugins.js'
import * as gbrain from './gbrain.js'

let _log: { info: (s: string) => void; warn: (s: string) => void } = { info: console.log, warn: console.warn }
export function setLogger(l: typeof _log) { _log = l }

// ── Provider resolution ────────────────────────────────────────────────────────

function resolveProvider(task: db.Task, workspacePath: string, extraContext?: string): { command: string; args: string[] } {
  const provider = task.provider_id
    ? db.getProvider(task.provider_id)
    : db.getDefaultProvider()
  if (!provider) throw new Error('no agent provider configured')

  const cwd   = task.cwd || workspacePath
  const model = task.model || 'claude-sonnet-4-6'
  const systemPrompt = db.getActiveSystemPrompt().content
  const promptWithPreamble = systemPrompt + (extraContext ?? '') + task.description
  let template: string[]
  try { template = JSON.parse(provider.args_template) } catch { template = [provider.args_template] }

  const args = template.map(a =>
    a.replace(/\{\{task\}\}/g,  promptWithPreamble)
     .replace(/\{\{model\}\}/g, model)
     .replace(/\{\{cwd\}\}/g,   cwd)
  )
  return { command: provider.command, args }
}

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
    // Recurring: fixed base folder per origin, timestamped subfolders per run
    const originId = task.origin_id ?? task.id
    const base = join(db.WORKSPACE_DIR, `${originId}-${slug}`)
    return join(base, ts)
  }
  return join(db.WORKSPACE_DIR, `${task.id}-${slug}-${ts}`)
}

// ── Process spawner ────────────────────────────────────────────────────────────

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    _log.info(`[queue] spawn: ${command} ${args.map(a => a.length > 60 ? a.slice(0,60)+'…' : a).join(' ')}`)
    const proc = spawn(command, args, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })

    const killTimer = setTimeout(() => {
      _log.warn(`[queue] process exceeded timeout (${timeoutMs}ms) — killing`)
      proc.kill('SIGTERM')
      setTimeout(() => proc.kill('SIGKILL'), 5000)
    }, timeoutMs)

    const stdoutBufs: string[] = []
    const stderrBufs: string[] = []
    proc.stdout.on('data', (d: Buffer) => stdoutBufs.push(d.toString()))
    proc.stderr.on('data', (d: Buffer) => stderrBufs.push(d.toString()))

    proc.on('close', (code) => {
      clearTimeout(killTimer)
      resolve({ stdout: stdoutBufs.join(''), stderr: stderrBufs.join(''), code: code ?? 1 })
    })

    proc.on('error', (e) => {
      clearTimeout(killTimer)
      reject(e)
    })
  })
}

// ── Output analyser ────────────────────────────────────────────────────────────

async function analyzeOutput(
  cwd: string,
  startedAt: number,
  _rawOutput: string
): Promise<{ toolCalls: number; tokensUsed: number; sessionId: string | null; sessionPath: string | null; artifacts: { path: string; description: string }[] }> {
  const sessionPath = findSessionJsonl(cwd, startedAt)
  let toolCalls  = 0
  let tokensUsed = 0
  let sessionId: string | null = null
  const artifacts: { path: string; description: string }[] = []

  if (sessionPath) {
    try {
      const analysis = analyzeSession(sessionPath)
      toolCalls  = analysis.toolCalls
      tokensUsed = analysis.tokensUsed
      sessionId  = analysis.sessionId
      artifacts.push(...analysis.artifacts)
    } catch (e) {
      _log.warn('[queue] session analysis error: ' + (e as Error).message)
    }
  }

  return { toolCalls, tokensUsed, sessionId, sessionPath, artifacts }
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

  const startedAt = Date.now()
  const { command, args } = resolveProvider(task, workspacePath, enrichment ?? undefined)
  const cwd = task.cwd || workspacePath

  let stdout: string
  let stderr: string
  let code: number

  try {
    ;({ stdout, stderr, code } = await runProcess(command, args, cwd, getTaskTimeoutMs()))
  } catch (e) {
    const errMsg = (e as Error).message
    db.setTaskFailed(task.id, errMsg)
    await plugins.invoke('post_task', { task, workspacePath, status: 'failed', tokensUsed: 0, toolCalls: 0, result: errMsg })
    return
  }

  const result = (stdout || stderr).trim()
  _log.info(`[queue] task #${task.id} exited code ${code}`)

  if (code !== 0) {
    const errResult = `exit ${code}: ${result.slice(0, 500)}`
    db.setTaskFailed(task.id, errResult)
    await plugins.invoke('post_task', { task, workspacePath, status: 'failed', tokensUsed: 0, toolCalls: 0, result })
    return
  }

  const { toolCalls, tokensUsed, sessionId, sessionPath, artifacts } =
    await analyzeOutput(cwd, startedAt, result)

  const { next } = db.completeTask(task.id, {
    result:         result.slice(0, 1000),
    session_id:     sessionId ?? undefined,
    session_path:   sessionPath ?? undefined,
    tool_calls:     toolCalls,
    tokens_used:    tokensUsed,
    workspace_path: workspacePath,
  })

  await plugins.invoke('post_task', { task, workspacePath, status: 'done', tokensUsed, toolCalls, result })
  if (artifacts.length) await saveArtifactsForTask(task, artifacts)
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

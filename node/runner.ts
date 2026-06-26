import Queue from 'better-queue'
import { createRequire } from 'module'
import { spawn } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync, existsSync } from 'fs'
import * as db from './db.js'
import * as scheduler from './scheduler.js'
import { findSessionJsonl, analyzeSession } from './session.js'

// Injected into every task prompt regardless of provider — agent declares artifacts via this protocol
const ARTIFACT_PREAMBLE = `\
## Restwalker Artifact Protocol
You are running as a background task inside restwalker, an idle-time Claude task runner.

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

const require = createRequire(import.meta.url)
const SqliteStore = require('better-queue-sqlite')

const QUEUE_DB = join(homedir(), '.restwalker', 'queue.db')
const POLL_MS  = parseInt(process.env.QUEUE_POLL_MS ?? '120000')

function resolveProvider(task: db.Task, workspacePath: string): { command: string; args: string[] } {
  const provider = task.provider_id
    ? db.getProvider(task.provider_id)
    : db.getDefaultProvider()
  if (!provider) throw new Error('no agent provider configured')

  const cwd   = task.cwd || workspacePath
  const model = task.model || 'claude-sonnet-4-6'
  const promptWithPreamble = ARTIFACT_PREAMBLE + task.description
  let template: string[]
  try { template = JSON.parse(provider.args_template) } catch { template = [provider.args_template] }

  const args = template.map(a =>
    a.replace(/\{\{task\}\}/g,  promptWithPreamble)
     .replace(/\{\{model\}\}/g, model)
     .replace(/\{\{cwd\}\}/g,   cwd)
  )
  return { command: provider.command, args }
}

async function gateOpen(): Promise<boolean> {
  try {
    const cfg    = db.getSettings()
    const staleS = parseFloat(cfg.CACHE_STALE_MIN) * 60
    const usage  = await scheduler.readUsage({ cacheStaleS: staleS })
    const result = await scheduler.canRun(usage, cfg)
    if (!result.ok) console.log(`[queue] gate: ${result.reason}`)
    return result.ok
  } catch (e) {
    console.warn('[queue] gate check error:', (e as Error).message)
    return false
  }
}

interface QueuePayload {
  id: string     // better-queue uses this as the task key
  taskId: number
  description: string
  cwd: string
}

async function processTask(input: QueuePayload): Promise<void> {
  const task = db.getTask(input.taskId)
  if (!task || task.status === 'cancelled') return

  console.log(`[queue] starting task #${task.id}: ${task.description.slice(0, 80)}`)
  db.setTaskRunning(task.id)

  const startedAt = Date.now()
  const workspacePath = join(db.WORKSPACE_DIR, String(task.id))
  if (!existsSync(workspacePath)) mkdirSync(workspacePath, { recursive: true })
  const cwd = task.cwd || workspacePath

  return new Promise((resolve, reject) => {
    const { command, args } = resolveProvider(task, workspacePath)
    console.log(`[queue] spawn: ${command} ${args.map(a => a.length > 60 ? a.slice(0,60)+'…' : a).join(' ')}`)
    const proc = spawn(command, args, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })

    const stdout: string[] = []
    const stderr: string[] = []
    proc.stdout.on('data', (d: Buffer) => stdout.push(d.toString()))
    proc.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))

    proc.on('close', (code) => {
      const result = stdout.join('').trim() || stderr.join('').trim()
      console.log(`[queue] task #${task.id} exited code ${code}`)

      if (code !== 0) {
        db.setTaskFailed(task.id, `exit ${code}: ${result.slice(0, 500)}`)
        reject(new Error(`exit ${code}`))
        return
      }

      const sessionPath = findSessionJsonl(cwd, startedAt)
      let toolCalls = 0
      let tokensUsed = 0
      let sessionId: string | null = null

      let artifactDecls: { path: string; description: string }[] = []

      if (sessionPath) {
        try {
          const analysis = analyzeSession(sessionPath)
          toolCalls      = analysis.toolCalls
          tokensUsed     = analysis.tokensUsed
          sessionId      = analysis.sessionId
          artifactDecls  = analysis.artifacts
        } catch (e) {
          console.warn('[queue] session analysis error:', (e as Error).message)
        }
      }

      db.setTaskDone(task.id, {
        result:         result.slice(0, 1000),
        session_id:     sessionId ?? undefined,
        session_path:   sessionPath ?? undefined,
        tool_calls:     toolCalls,
        tokens_used:    tokensUsed,
        workspace_path: workspacePath,
      })

      if (artifactDecls.length) {
        try {
          const saved = db.saveArtifacts(task.id, artifactDecls)
          console.log(`[queue] task #${task.id} saved ${saved.length} artifact(s)`)
        } catch (e) {
          console.warn('[queue] artifact save error:', (e as Error).message)
        }
      }

      const next = db.createNextRun(task)
      if (next) console.log(`[queue] next run of #${task.id} scheduled at ${next.next_run_at}`)

      resolve()
    })

    proc.on('error', (e) => {
      db.setTaskFailed(task.id, e.message)
      reject(e)
    })
  })
}

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
  // Lazily get the queue instance — set by app.ts after startQueue()
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

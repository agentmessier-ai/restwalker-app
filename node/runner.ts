import { spawn } from 'child_process'
import * as db from './db.js'
import * as scheduler from './scheduler.js'
import { findSessionJsonl, analyzeSession, skillify } from './skillifier.js'

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude'
const POLL_MS    = parseInt(process.env.QUEUE_POLL_MS ?? '120000')  // 2 min

let running = false

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

async function runTask(task: db.Task): Promise<void> {
  console.log(`[queue] starting task #${task.id}: ${task.description.slice(0, 80)}`)
  db.setTaskRunning(task.id)

  const startedAt = Date.now()
  const cwd = task.cwd || process.env.HOME || '.'

  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, [
      '--print', '--permission-mode', 'auto', '--output-format', 'text',
      task.description,
    ], { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })

    const stdout: string[] = []
    const stderr: string[] = []
    proc.stdout.on('data', (d: Buffer) => stdout.push(d.toString()))
    proc.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))

    proc.on('close', (code) => {
      const result = stdout.join('').trim() || stderr.join('').trim()
      console.log(`[queue] task #${task.id} exited with code ${code}`)

      if (code !== 0) {
        db.setTaskFailed(task.id, `exit ${code}: ${result.slice(0, 500)}`)
        resolve()
        return
      }

      const sessionPath = findSessionJsonl(cwd, startedAt)
      let skillPath: string | null = null
      let toolCalls = 0
      let tokensUsed = 0
      let sessionId: string | null = null

      if (sessionPath) {
        try {
          const analysis = analyzeSession(sessionPath)
          toolCalls  = analysis.toolCalls
          tokensUsed = analysis.tokensUsed
          sessionId  = analysis.sessionId

          if (analysis.toolCalls >= 5) {
            skillPath = skillify(analysis, task.id)
            if (skillPath) {
              db.recordSkill({
                name:        `auto-${analysis.sessionId.slice(0, 8)}`,
                description: analysis.userRequest.slice(0, 200),
                task_id:     task.id,
                session_id:  analysis.sessionId,
                tool_calls:  analysis.toolCalls,
                path:        skillPath,
              })
              console.log(`[queue] skill written: ${skillPath}`)
            }
          } else {
            console.log(`[queue] task #${task.id} had ${analysis.toolCalls} tool calls — skipping skillify`)
          }
        } catch (e) {
          console.warn('[queue] skillifier error:', (e as Error).message)
        }
      }

      db.setTaskDone(task.id, {
        result:       result.slice(0, 1000),
        session_id:   sessionId ?? undefined,
        session_path: sessionPath ?? undefined,
        skill_path:   skillPath ?? undefined,
        tool_calls:   toolCalls,
        tokens_used:  tokensUsed,
      })

      resolve()
    })

    proc.on('error', (e) => {
      db.setTaskFailed(task.id, e.message)
      resolve()
    })
  })
}

export async function startQueue(log: (msg: string) => void): Promise<void> {
  if (running) return
  running = true
  log('[queue] runner started')

  const tick = async () => {
    const task = db.nextPendingTask()
    if (!task) { setTimeout(tick, POLL_MS); return }

    const ok = await gateOpen()
    if (!ok) { setTimeout(tick, POLL_MS); return }

    await runTask(task)
    setTimeout(tick, 5000)  // immediately try next
  }

  tick()
}

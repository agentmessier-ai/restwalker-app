import { spawn } from 'child_process'
import { readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import chokidar from 'chokidar'
import type { AgentLoop, AgentLoopContext, AgentLoopResult, EventCallback } from '../agent-loop.js'
import { findSessionJsonl } from '../session.js'

const ARTIFACT_RE = /^ARTIFACT:\s*(\{.+\})\s*$/m

export class ClaudePrintLoop implements AgentLoop {
  constructor(private readonly timeoutMs: number) {}

  async run(ctx: AgentLoopContext, onEvent: EventCallback): Promise<AgentLoopResult> {
    const { task, workspacePath, systemPrompt, model, extraContext, cwd } = ctx

    // Build args from provider template (replicated inline to avoid coupling to runner)
    const promptWithPreamble = systemPrompt + (extraContext ?? '') + task.description
    const args = [
      '--print',
      '--permission-mode', 'auto',
      '--output-format', 'text',
      '--model', model,
      promptWithPreamble,
    ]

    const startedAt = Date.now()
    const stdoutBufs: string[] = []
    const stderrBufs: string[] = []

    // Persist the full run output under <workspace>/logs/ — the daemon log only
    // keeps a truncated result, this keeps the complete stdout/stderr per task.
    // Called on every exit path (success and failure) so a failed run is still
    // inspectable; logging never throws into the task.
    const writeLogs = () => {
      try {
        const logsDir = join(workspacePath, 'logs')
        mkdirSync(logsDir, { recursive: true })
        const stdout = stdoutBufs.join('')
        const stderr = stderrBufs.join('')
        if (stdout) writeFileSync(join(logsDir, 'stdout.log'), stdout, 'utf8')
        if (stderr) writeFileSync(join(logsDir, 'stderr.log'), stderr, 'utf8')
      } catch { /* best-effort — never fail a task over logging */ }
    }

    await new Promise<void>((resolve, reject) => {
      const claudeBin = process.env.CLAUDE_BIN ?? 'claude'
      const proc = spawn(claudeBin, args, {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let timedOut = false
      const killTimer = setTimeout(() => {
        timedOut = true
        proc.kill('SIGTERM')
        setTimeout(() => proc.kill('SIGKILL'), 5000)
      }, this.timeoutMs)

      proc.stdout.on('data', (d: Buffer) => stdoutBufs.push(d.toString()))
      proc.stderr.on('data', (d: Buffer) => stderrBufs.push(d.toString()))

      // ── Real-time JSONL watching ───────────────────────────────────────────
      let watcher: ReturnType<typeof chokidar.watch> | null = null
      let lastLineIndex = 0
      let turnCounter = 0

      const processLines = async (sessionPath: string) => {
        try {
          const content = readFileSync(sessionPath, 'utf8')
          const lines = content.split('\n').filter(Boolean)
          const newLines = lines.slice(lastLineIndex)
          lastLineIndex = lines.length

          for (const line of newLines) {
            let d: Record<string, unknown>
            try { d = JSON.parse(line) } catch { continue }

            const type = d.type as string

            if (type === 'assistant') {
              const msg = (d as { message?: { content?: unknown; usage?: { input_tokens?: number; output_tokens?: number } } }).message ?? {}
              const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage ?? {}
              const inputTokens = (usage as { input_tokens?: number }).input_tokens ?? 0

              turnCounter++
              await onEvent({ type: 'turn_start', turn: turnCounter, inputTokens })

              const content = (msg as { content?: unknown }).content
              if (Array.isArray(content)) {
                let textAcc = ''
                let thinkingAcc = ''

                for (const c of content as Array<Record<string, unknown>>) {
                  if (c.type === 'text' && typeof c.text === 'string') {
                    textAcc += c.text

                    // emit artifact events inline
                    const re = new RegExp(ARTIFACT_RE.source, 'gm')
                    let m: RegExpExecArray | null
                    while ((m = re.exec(c.text as string)) !== null) {
                      try {
                        const decl = JSON.parse(m[1]) as { path?: string; description?: string }
                        if (decl.path) {
                          await onEvent({ type: 'artifact', path: decl.path, description: decl.description ?? '' })
                        }
                      } catch { /* ignore malformed */ }
                    }
                  } else if (c.type === 'thinking' && typeof c.thinking === 'string') {
                    thinkingAcc += c.thinking
                  } else if (c.type === 'tool_use') {
                    // emit any accumulated text first
                    if (textAcc || thinkingAcc) {
                      await onEvent({ type: 'message', content: textAcc, thinking: thinkingAcc || undefined })
                      textAcc = ''
                      thinkingAcc = ''
                    }
                    await onEvent({
                      type: 'tool_call',
                      tool: c.name as string,
                      input: (c.input as Record<string, unknown>) ?? {},
                      callId: c.id as string,
                    })
                  }
                }

                if (textAcc || thinkingAcc) {
                  await onEvent({ type: 'message', content: textAcc, thinking: thinkingAcc || undefined })
                }
              }
            }

            if (type === 'user') {
              const msg = (d as { message?: { content?: unknown } }).message ?? {}
              const content = (msg as { content?: unknown }).content
              if (Array.isArray(content)) {
                for (const c of content as Array<Record<string, unknown>>) {
                  if (c.type === 'tool_result') {
                    const resultContent = c.content
                    const resultStr = typeof resultContent === 'string'
                      ? resultContent
                      : JSON.stringify(resultContent)
                    await onEvent({
                      type: 'tool_result',
                      tool: '',  // JSONL tool_result doesn't repeat the tool name
                      callId: c.tool_use_id as string,
                      result: resultStr,
                      isError: Boolean(c.is_error),
                    })
                  }
                }
              }
            }
          }
        } catch { /* file not ready yet */ }
      }

      // Poll until the session file appears (up to 10s), then watch it
      let sessionPath: string | null = null
      let pollCount = 0
      const pollInterval = setInterval(() => {
        pollCount++
        sessionPath = findSessionJsonl(cwd, startedAt)
        if (sessionPath) {
          clearInterval(pollInterval)
          watcher = chokidar.watch(sessionPath, { persistent: false, usePolling: false })
          watcher.on('change', () => { processLines(sessionPath!).catch(() => {}) })
          // process any lines already written
          processLines(sessionPath).catch(() => {})
        } else if (pollCount >= 20) {
          // gave up after 10s
          clearInterval(pollInterval)
        }
      }, 500)

      proc.on('close', (code) => {
        clearTimeout(killTimer)
        clearInterval(pollInterval)

        // drain any remaining lines after process exits
        const drain = sessionPath
          ? processLines(sessionPath).catch(() => {})
          : Promise.resolve()

        drain.finally(() => {
          if (watcher) watcher.close().catch(() => {})
          writeLogs()
          if (timedOut) {
            const secs = Math.round(this.timeoutMs / 1000)
            const mins = Math.round(secs / 60 * 10) / 10
            reject(new Error(`timed out after ${secs}s (${mins} min) — raise this task's timeout_s or the global TASK_TIMEOUT_S to give it more time`))
          } else if ((code ?? 1) !== 0) {
            const errOut = (stdoutBufs.join('') || stderrBufs.join('')).trim()
            reject(new Error(`exit ${code}: ${errOut.slice(0, 500)}`))
          } else {
            resolve()
          }
        })
      })

      proc.on('error', (e) => {
        clearTimeout(killTimer)
        clearInterval(pollInterval)
        if (watcher) watcher.close().catch(() => {})
        writeLogs()
        reject(e)
      })
    })

    // ── Post-run analysis ──────────────────────────────────────────────────────
    const sessionPath = findSessionJsonl(cwd, startedAt)
    let toolCalls  = 0
    let tokensUsed = 0
    let sessionId: string | null = null
    const artifacts: { path: string; description: string }[] = []
    let tags: string[] = []

    if (sessionPath) {
      try {
        const { analyzeSession } = await import('../session.js')
        const analysis = analyzeSession(sessionPath)
        toolCalls  = analysis.toolCalls
        tokensUsed = analysis.tokensUsed
        sessionId  = analysis.sessionId
        artifacts.push(...analysis.artifacts)
        tags = analysis.tags
      } catch { /* best-effort */ }
    }

    const rawOut = (stdoutBufs.join('') || stderrBufs.join('')).trim()

    return {
      result:      rawOut.slice(0, 1000),
      tokensUsed,
      toolCalls,
      sessionId,
      sessionPath,
      artifacts,
      tags,
    }
  }
}

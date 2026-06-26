import type { FastifyInstance } from 'fastify'
import { existsSync, readFileSync } from 'fs'
import * as db from '../db.js'
import { enqueueTask, forceRunTask } from '../runner.js'
import { S } from './schemas.js'

export default async function queueRoutes(app: FastifyInstance) {
  app.get('/queue/stats', {
    schema: {
      tags: ['queue'],
      summary: 'Task counts by status',
      response: {
        200: {
          type: 'object',
          properties: {
            scheduled: { type: 'integer' },
            pending:   { type: 'integer' },
            running:   { type: 'integer' },
            done:      { type: 'integer' },
            failed:    { type: 'integer' },
            total:     { type: 'integer' },
          },
        },
      },
    },
  }, async () => db.queueStats())

  app.get('/queue', {
    schema: {
      tags: ['queue'],
      summary: 'List tasks with pagination, filtering, and sorting',
      querystring: {
        type: 'object',
        properties: {
          limit:  { type: 'integer', default: 25, minimum: 1, maximum: 100 },
          offset: { type: 'integer', default: 0,  minimum: 0 },
          status:       { type: 'string', enum: ['pending','running','scheduled','done','failed','cancelled'] },
          schedule_type:{ type: 'string', enum: ['once', 'recurring'] },
          sort:         { type: 'string', enum: ['created', 'finished', 'duration'], default: 'created' },
          dir:          { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            tasks: { type: 'array', items: S.task },
            total: { type: 'integer' },
          },
        },
      },
    },
  }, async (req) => {
    const q      = req.query as Record<string, string>
    const limit  = Math.min(parseInt(q.limit  ?? '25'), 100)
    const offset = Math.max(parseInt(q.offset ?? '0'),  0)
    const status       = q.status        as db.TaskStatus | undefined
    const scheduleType = q.schedule_type as 'once' | 'recurring' | undefined
    const sort         = (q.sort as 'created' | 'finished' | 'duration') || 'created'
    const dir          = (q.dir  as 'asc' | 'desc') || 'desc'
    return {
      tasks: db.getTasks(limit, offset, { status, scheduleType, sort, dir }),
      total: db.getTaskCount(status, scheduleType),
    }
  })

  app.get('/queue/:id', {
    schema: {
      tags: ['queue'],
      summary: 'Get a single task',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      response: { 200: S.task, 404: S.error },
    },
  }, async (req, reply) => {
    const task = db.getTask(parseInt((req.params as { id: string }).id))
    if (!task) return reply.code(404).send({ error: 'not found' })
    return task
  })

  app.post('/queue', {
    schema: {
      tags: ['queue'],
      summary: 'Enqueue a new task',
      body: {
        type: 'object',
        required: ['description'],
        properties: {
          description:      { type: 'string' },
          cwd:              { type: 'string' },
          model:            { type: 'string' },
          provider_id:      { type: 'integer' },
          schedule:         { type: 'string', enum: ['once','hourly','daily','weekly','monthly'], default: 'once' },
          webhook_pre_url:  { type: 'string' },
          webhook_post_url: { type: 'string' },
          webhook_timeout_ms: { type: 'integer', default: 10000 },
          webhook_retry:    { type: 'integer', default: 2 },
          webhook_ignore_ssl: { type: 'integer', default: 0 },
          timeout_ms:       { type: 'integer', description: 'Per-task agent timeout in ms; omit to use the global TASK_TIMEOUT_MS setting (default 10 min)' },
        },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' }, task: S.task } },
        400: S.error,
      },
    },
  }, async (req, reply) => {
    const { description, cwd, model, provider_id, schedule,
            webhook_pre_url, webhook_post_url, webhook_timeout_ms, webhook_retry, webhook_ignore_ssl, timeout_ms } =
      req.body as {
        description?: string; cwd?: string; model?: string; provider_id?: number; schedule?: db.TaskSchedule
        webhook_pre_url?: string; webhook_post_url?: string
        webhook_timeout_ms?: number; webhook_retry?: number; webhook_ignore_ssl?: number; timeout_ms?: number
      }
    if (!description?.trim()) return reply.code(400).send({ error: 'description required' })
    const task = db.addTask(description.trim(), cwd?.trim(), model?.trim(), provider_id, schedule || 'once', {
      webhookPreUrl:    webhook_pre_url    ?? null,
      webhookPostUrl:   webhook_post_url   ?? null,
      webhookTimeoutMs: webhook_timeout_ms ?? 10000,
      webhookRetry:     webhook_retry      ?? 2,
      webhookIgnoreSsl: webhook_ignore_ssl ?? 0,
      timeoutMs:        timeout_ms         ?? null,
    })
    enqueueTask(task)
    app.log.info(`[queue] added #${task.id} (${task.schedule}): ${description.slice(0, 80)}`)
    return { ok: true, task }
  })

  app.delete('/queue/:id', {
    schema: {
      tags: ['queue'],
      summary: 'Delete a task (any status except running)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      response: { 200: S.ok, 404: S.error, 409: S.error },
    },
  }, async (req, reply) => {
    const id   = parseInt((req.params as { id: string }).id)
    const task = db.getTask(id)
    if (!task) return reply.code(404).send({ error: 'not found' })
    if (task.status === 'running') return reply.code(409).send({ error: 'cannot delete a running task' })
    const deleted = db.deleteTask(id)
    if (!deleted) return reply.code(404).send({ error: 'not found' })
    return { ok: true }
  })

  app.post('/queue/:id/force-run', {
    schema: {
      tags: ['queue'],
      summary: 'Force-run a pending task immediately, bypassing the usage gate',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      response: {
        200: S.ok,
        404: S.error,
        409: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' } } },
      },
    },
  }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id)
    const task = db.getTask(id)
    if (!task) return reply.code(404).send({ error: 'not found' })
    return forceRunTask(id, msg => app.log.info(msg))
  })

  app.get('/queue/:id/session', {
    schema: {
      tags: ['queue'],
      summary: 'Get the parsed Claude Code session transcript for a task',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            turns: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role:       { type: 'string', enum: ['user', 'assistant'] },
                  text:       { type: 'string', nullable: true },
                  thinking:   { type: 'string', nullable: true },
                  tool_calls: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name:   { type: 'string' },
                        input:  { type: 'object', additionalProperties: true },
                        result: { type: 'string', nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        404: S.error,
        500: S.error,
      },
    },
  }, async (req, reply) => {
    const task = db.getTask(parseInt((req.params as { id: string }).id))
    if (!task) return reply.code(404).send({ error: 'not found' })
    if (!task.session_path) return reply.code(404).send({ error: 'no session recorded' })
    if (!existsSync(task.session_path)) return reply.code(404).send({ error: 'session file missing' })

    try {
      const lines = readFileSync(task.session_path, 'utf8').split('\n').filter(Boolean)

      const toolResults = new Map<string, string>()
      for (const line of lines) {
        const e = JSON.parse(line)
        if (e.type === 'user' && Array.isArray(e.message?.content)) {
          for (const b of e.message.content) {
            if (b.type !== 'tool_result') continue
            const raw = Array.isArray(b.content)
              ? b.content.map((c: {text?: string}) => c.text ?? '').join('')
              : String(b.content ?? '')
            toolResults.set(b.tool_use_id, raw.slice(0, 3000))
          }
        }
      }

      interface Turn {
        role: 'user' | 'assistant'
        text: string | null
        thinking: string | null
        tool_calls: { name: string; input: Record<string, unknown>; result: string | null }[]
      }
      const turns: Turn[] = []
      let firstUser = true

      for (const line of lines) {
        const e = JSON.parse(line)

        if (e.type === 'user') {
          const content = e.message?.content
          let text: string | null = null
          if (typeof content === 'string') text = content.trim() || null
          else if (Array.isArray(content)) {
            const parts = content.filter((b: {type:string}) => b.type === 'text').map((b: {text:string}) => b.text)
            text = parts.join('\n').trim() || null
          }
          if (firstUser) { firstUser = false; if (text) turns.push({ role: 'user', text, thinking: null, tool_calls: [] }) }
          else if (text)  turns.push({ role: 'user', text, thinking: null, tool_calls: [] })

        } else if (e.type === 'assistant') {
          const content = e.message?.content
          if (!Array.isArray(content)) continue
          const thinking = content.filter((b: {type:string}) => b.type === 'thinking')
            .map((b: {thinking:string}) => b.thinking).join('\n').slice(0, 8000) || null
          const text = content.filter((b: {type:string}) => b.type === 'text')
            .map((b: {text:string}) => b.text).join('\n').trim().slice(0, 4000) || null
          const tool_calls = content.filter((b: {type:string}) => b.type === 'tool_use')
            .map((b: {id:string;name:string;input:Record<string,unknown>}) => ({
              name:   b.name,
              input:  b.input,
              result: toolResults.get(b.id) ?? null,
            }))
          if (thinking || text || tool_calls.length)
            turns.push({ role: 'assistant', text, thinking, tool_calls })
        }
      }

      return { turns }
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message })
    }
  })

  // ── Artifacts ─────────────────────────────────────────────────────────────────

  app.get('/queue/:id/artifacts', {
    schema: {
      tags: ['queue'],
      summary: 'List artifacts declared by a task',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            workspace_path: { type: 'string', nullable: true },
            artifacts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id:          { type: 'integer' },
                  path:        { type: 'string' },
                  description: { type: 'string' },
                  mime_type:   { type: 'string' },
                  size:        { type: 'integer' },
                },
              },
            },
          },
        },
        404: S.error,
      },
    },
  }, async (req, reply) => {
    const task = db.getTask(parseInt((req.params as { id: string }).id))
    if (!task) return reply.code(404).send({ error: 'not found' })
    return { workspace_path: task.workspace_path ?? null, artifacts: db.getArtifacts(task.id) }
  })

  app.get('/artifacts/:id/content', {
    schema: {
      tags: ['queue'],
      summary: 'Get artifact file content',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    },
  }, async (req, reply) => {
    const artifact = db.getArtifact(parseInt((req.params as { id: string }).id))
    if (!artifact) return reply.code(404).send({ error: 'not found' })
    if (!existsSync(artifact.path)) return reply.code(404).send({ error: 'file not found on disk' })
    const content = readFileSync(artifact.path, 'utf8')
    reply.header('Content-Type', artifact.mime_type + '; charset=utf-8')
    return reply.send(content)
  })

  // ── Recurring task runs ───────────────────────────────────────────────────────

  app.get('/queue/origin/:id/runs', {
    schema: {
      tags: ['queue'],
      summary: 'Get all completed runs for a recurring task chain',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      response: { 200: { type: 'object', properties: { runs: { type: 'array', items: S.task } } } },
    },
  }, async (req) => {
    const originId = parseInt((req.params as { id: string }).id)
    return { runs: db.getRunsByOrigin(originId) }
  })
}

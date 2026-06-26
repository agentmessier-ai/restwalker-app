import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import chokidar from 'chokidar'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { createWriteStream, readFileSync, existsSync } from 'fs'

import * as db from './db.js'
import * as scheduler from './scheduler.js'
import { startQueue, setQueue, enqueueTask, forceRunTask } from './runner.js'
import type { Settings } from './db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT      = parseInt(process.env.PORT ?? '47290')
const LOG_FILE  = process.env.RESTWALKER_LOG ?? join(homedir(), '.restwalker', 'restwalker.log')

const app = Fastify({
  logger: {
    level: 'info',
    stream: createWriteStream(LOG_FILE, { flags: 'a' }),
  },
  disableRequestLogging: true,
})

// ── OpenAPI ────────────────────────────────────────────────────────────────────

await app.register(fastifySwagger, {
  openapi: {
    openapi: '3.0.3',
    info: {
      title: 'Restwalker API',
      description: 'Background Claude task queue with usage-gate scheduling',
      version: '1.0.0',
    },
    tags: [
      { name: 'health',     description: 'Health and status' },
      { name: 'usage',      description: 'Claude usage monitoring and sync' },
      { name: 'settings',   description: 'Daemon configuration' },
      { name: 'providers',  description: 'Agent provider management' },
      { name: 'queue',      description: 'Task queue' },
      { name: 'discovery',  description: 'Models and projects' },
    ],
  },
})

await app.register(fastifySwaggerUi, {
  routePrefix: '/docs',
  uiConfig: { docExpansion: 'list', deepLinking: true },
})

// ── Static ─────────────────────────────────────────────────────────────────────

await app.register(fastifyStatic, {
  root: join(__dirname, '..'),
  serve: false,
})

// ── Reusable schemas ───────────────────────────────────────────────────────────

const S = {
  provider: {
    type: 'object',
    properties: {
      id:           { type: 'integer' },
      name:         { type: 'string' },
      command:      { type: 'string' },
      args_template:{ type: 'string' },
      is_default:   { type: 'integer' },
      created_at:   { type: 'string', format: 'date-time' },
    },
  },
  task: {
    type: 'object',
    properties: {
      id:           { type: 'integer' },
      description:  { type: 'string' },
      cwd:          { type: 'string' },
      model:        { type: 'string' },
      provider_id:  { type: 'integer', nullable: true },
      schedule:     { type: 'string', enum: ['once','hourly','daily','weekly','monthly'] },
      next_run_at:  { type: 'string', nullable: true },
      status:       { type: 'string', enum: ['scheduled','pending','running','done','failed','cancelled'] },
      result:       { type: 'string', nullable: true },
      session_id:   { type: 'string', nullable: true },
      session_path: { type: 'string', nullable: true },
      tool_calls:   { type: 'integer' },
      tokens_used:  { type: 'integer' },
      created_at:   { type: 'string', format: 'date-time' },
      started_at:   { type: 'string', nullable: true },
      finished_at:  { type: 'string', nullable: true },
    },
  },
  ok: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
  },
  error: {
    type: 'object',
    properties: { error: { type: 'string' } },
  },
} as const

// ── Sync helper ────────────────────────────────────────────────────────────────

async function doSync({ forceRefresh = false } = {}): Promise<void> {
  const cfg    = db.getSettings()
  const staleS = parseFloat(cfg.CACHE_STALE_MIN) * 60
  const usage  = await scheduler.readUsage({ cacheStaleS: staleS, forceRefresh })
  if (usage && !usage.stale) {
    db.recordSnapshot(usage.five_hour_pct, usage.weekly_pct, usage.weekly_resets_at)
    app.log.info(`[sync] 5h=${usage.five_hour_pct.toFixed(1)}% weekly=${usage.weekly_pct.toFixed(1)}% source=${usage.source}`)
  }
}

// ── File watcher ───────────────────────────────────────────────────────────────

const watcher = chokidar.watch(scheduler.USAGE_CACHE, { persistent: true, ignoreInitial: true })
watcher.on('change', () => {
  app.log.info('[watcher] cache file changed — syncing')
  doSync().catch((e: Error) => app.log.warn('[watcher] sync error: ' + e.message))
})

// ── Background poller ──────────────────────────────────────────────────────────

function startPoller(): void {
  const cfg        = db.getSettings()
  const intervalMs = parseFloat(cfg.POLL_INTERVAL_MIN) * 60_000
  setTimeout(async () => {
    await doSync({ forceRefresh: true }).catch((e: Error) => app.log.warn('[poller] ' + e.message))
    startPoller()
  }, intervalMs)
}

// ── Health ─────────────────────────────────────────────────────────────────────

app.get('/healthz', {
  schema: {
    tags: ['health'],
    summary: 'Health check',
    response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
  },
}, async () => ({ ok: true }))

app.get('/', async (_req, reply) => reply.sendFile('index.html'))

// ── Usage ──────────────────────────────────────────────────────────────────────

app.post('/sync', {
  schema: {
    tags: ['usage'],
    summary: 'Force a usage cache refresh',
    response: {
      200: { type: 'object', properties: { ok: { type: 'boolean' }, stale: { type: 'boolean' } } },
    },
  },
}, async () => {
  const cfg    = db.getSettings()
  const staleS = parseFloat(cfg.CACHE_STALE_MIN) * 60
  const usage  = await scheduler.readUsage({ cacheStaleS: staleS, forceRefresh: true })
  if (usage && !usage.stale) {
    db.recordSnapshot(usage.five_hour_pct, usage.weekly_pct, usage.weekly_resets_at)
    app.log.info(`[sync] 5h=${usage.five_hour_pct.toFixed(1)}% weekly=${usage.weekly_pct.toFixed(1)}% source=${usage.source}`)
  }
  return { ok: true, stale: usage?.stale ?? true }
})

app.get('/can-run', {
  schema: {
    tags: ['usage'],
    summary: 'Check whether the gate is open for a project',
    querystring: {
      type: 'object',
      properties: { project: { type: 'string', default: 'default' } },
    },
    response: {
      200: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, provider: { type: 'string', nullable: true } },
      },
    },
  },
}, async (req) => {
  const project = (req.query as Record<string, string>).project ?? 'default'
  const cfg     = db.getSettings()
  const staleS  = parseFloat(cfg.CACHE_STALE_MIN) * 60
  const usage   = await scheduler.readUsage({ cacheStaleS: staleS })
  const result  = await scheduler.canRun(usage, cfg)
  app.log.info(`[can-run] project=${project} ok=${result.ok} reason=${result.reason}`)
  return result
})

app.get('/status', {
  schema: {
    tags: ['usage'],
    summary: 'Full daemon status including usage, window, and thresholds',
    response: {
      200: {
        type: 'object',
        properties: {
          window:         { type: 'string', enum: ['coding', 'idle'] },
          next_idle_in_s: { type: 'number', nullable: true },
          ok:             { type: 'boolean' },
          provider:       { type: 'string', nullable: true },
          reason:         { type: 'string' },
          usage: {
            type: 'object',
            properties: {
              five_hour_pct:    { type: 'number', nullable: true },
              weekly_pct:       { type: 'number', nullable: true },
              weekly_resets_at: { type: 'string', nullable: true },
              cache_age_s:      { type: 'number', nullable: true },
              stale:            { type: 'boolean' },
              source:           { type: 'string', nullable: true },
            },
          },
          thresholds: {
            type: 'object',
            properties: {
              coding_start_h:       { type: 'number' },
              coding_end_h:         { type: 'number' },
              timezone:             { type: 'string' },
              five_hour_pause_pct:  { type: 'number' },
              weekly_reserve_pct:   { type: 'number' },
              weekly_hard_stop_pct: { type: 'number' },
              cache_stale_min:      { type: 'number' },
              poll_interval_min:    { type: 'number' },
            },
          },
        },
      },
    },
  },
}, async () => {
  const cfg    = db.getSettings()
  const staleS = parseFloat(cfg.CACHE_STALE_MIN) * 60
  const now    = new Date()
  const usage  = await scheduler.readUsage({ cacheStaleS: staleS })
  const decision = await scheduler.canRun(usage, cfg)
  const snap   = db.latestSnapshot()

  const startH = parseInt(cfg.CODING_START_H)
  const endH   = parseInt(cfg.CODING_END_H)
  const tz     = cfg.TIMEZONE

  return {
    window:         scheduler.isCodingWindow(now, startH, endH, tz) ? 'coding' : 'idle',
    next_idle_in_s: scheduler.nextIdleInS(now, startH, endH, tz),
    ok:             decision.ok,
    provider:       decision.provider,
    reason:         decision.reason,
    usage: {
      five_hour_pct:    usage?.five_hour_pct    ?? null,
      weekly_pct:       usage?.weekly_pct       ?? null,
      weekly_resets_at: usage?.weekly_resets_at ?? null,
      cache_age_s:      usage?.age_s != null ? Math.round(usage.age_s * 10) / 10 : null,
      stale:            usage?.stale ?? true,
      source:           usage?.source ?? null,
    },
    last_db_snapshot: snap,
    thresholds: {
      coding_start_h:       startH,
      coding_end_h:         endH,
      timezone:             tz,
      five_hour_pause_pct:  parseFloat(cfg.FIVE_HOUR_PAUSE_PCT),
      weekly_reserve_pct:   parseFloat(cfg.WEEKLY_RESERVE_PCT),
      weekly_hard_stop_pct: parseFloat(cfg.WEEKLY_HARD_STOP_PCT),
      cache_stale_min:      parseFloat(cfg.CACHE_STALE_MIN),
      poll_interval_min:    parseFloat(cfg.POLL_INTERVAL_MIN),
    },
  }
})

app.get('/history', {
  schema: {
    tags: ['usage'],
    summary: 'Usage history bucketed into 15-minute intervals',
    querystring: {
      type: 'object',
      properties: { hours: { type: 'integer', default: 48, minimum: 1, maximum: 720 } },
    },
    response: {
      200: {
        type: 'object',
        properties: {
          history: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                bucket:        { type: 'string', format: 'date-time' },
                five_hour_pct: { type: 'number' },
                weekly_pct:    { type: 'number' },
                samples:       { type: 'integer' },
              },
            },
          },
        },
      },
    },
  },
}, async (req) => {
  const hours = parseInt((req.query as Record<string, string>).hours ?? '48')
  return { history: db.usageHistory(hours) }
})

// ── Settings ───────────────────────────────────────────────────────────────────

app.get('/settings', {
  schema: {
    tags: ['settings'],
    summary: 'Get all settings',
    response: {
      200: {
        type: 'object',
        additionalProperties: { type: 'string' },
      },
    },
  },
}, async () => db.getSettings())

app.post('/settings', {
  schema: {
    tags: ['settings'],
    summary: 'Update one or more settings',
    body: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    response: {
      200: { type: 'object', properties: { ok: { type: 'boolean' }, settings: { type: 'object', additionalProperties: { type: 'string' } } } },
      422: S.error,
    },
  },
}, async (req, reply) => {
  try {
    db.updateSettings(req.body as Partial<Settings>)
    return { ok: true, settings: db.getSettings() }
  } catch (e) {
    return reply.code(422).send({ error: (e as Error).message })
  }
})

// ── Providers ──────────────────────────────────────────────────────────────────

app.get('/providers', {
  schema: {
    tags: ['providers'],
    summary: 'List all agent providers',
    response: { 200: { type: 'object', properties: { providers: { type: 'array', items: S.provider } } } },
  },
}, async () => ({ providers: db.getProviders() }))

app.post('/providers', {
  schema: {
    tags: ['providers'],
    summary: 'Add an agent provider',
    body: {
      type: 'object',
      required: ['name', 'command'],
      properties: {
        name:         { type: 'string' },
        command:      { type: 'string' },
        args_template:{ type: 'string', description: 'JSON string array with {{task}}, {{model}}, {{cwd}} placeholders' },
      },
    },
    response: {
      200: { type: 'object', properties: { ok: { type: 'boolean' }, provider: S.provider } },
      400: S.error,
    },
  },
}, async (req, reply) => {
  const { name, command, args_template } = req.body as { name?: string; command?: string; args_template?: string }
  if (!name?.trim() || !command?.trim()) return reply.code(400).send({ error: 'name and command required' })
  const provider = db.addProvider(name.trim(), command.trim(), args_template?.trim() || '["{{task}}"]')
  return { ok: true, provider }
})

app.put('/providers/:id', {
  schema: {
    tags: ['providers'],
    summary: 'Update an agent provider',
    params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    body: {
      type: 'object',
      properties: {
        name:         { type: 'string' },
        command:      { type: 'string' },
        args_template:{ type: 'string' },
      },
    },
    response: { 200: S.ok, 404: S.error },
  },
}, async (req, reply) => {
  const id = parseInt((req.params as { id: string }).id)
  if (!db.getProvider(id)) return reply.code(404).send({ error: 'not found' })
  const { name, command, args_template } = req.body as Partial<db.Provider>
  db.updateProvider(id, { name, command, args_template })
  return { ok: true }
})

app.post('/providers/:id/default', {
  schema: {
    tags: ['providers'],
    summary: 'Set a provider as the default',
    params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    response: { 200: S.ok, 404: S.error },
  },
}, async (req, reply) => {
  const id = parseInt((req.params as { id: string }).id)
  if (!db.getProvider(id)) return reply.code(404).send({ error: 'not found' })
  db.setDefaultProvider(id)
  return { ok: true }
})

app.delete('/providers/:id', {
  schema: {
    tags: ['providers'],
    summary: 'Delete an agent provider',
    params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    response: { 200: S.ok, 404: S.error, 409: S.error },
  },
}, async (req, reply) => {
  const id = parseInt((req.params as { id: string }).id)
  if (!db.getProvider(id)) return reply.code(404).send({ error: 'not found' })
  if (db.getProviders().length <= 1) return reply.code(409).send({ error: 'cannot delete last provider' })
  db.deleteProvider(id)
  return { ok: true }
})

// ── Discovery ──────────────────────────────────────────────────────────────────

app.get('/projects', {
  schema: {
    tags: ['discovery'],
    summary: 'List Claude Code projects from history, sorted by recency',
    response: {
      200: {
        type: 'object',
        properties: {
          projects: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                cwd:         { type: 'string' },
                last_active: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
    },
  },
}, async () => {
  const historyFile = join(homedir(), '.claude', 'history.jsonl')
  if (!existsSync(historyFile)) return { projects: [] }

  const seen = new Map<string, number>()
  try {
    const lines = readFileSync(historyFile, 'utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      const d = JSON.parse(line) as { project?: string; timestamp?: number }
      const p = d.project?.trim()
      if (!p || !existsSync(p)) continue
      const ts = d.timestamp ?? 0
      if (ts > (seen.get(p) ?? 0)) seen.set(p, ts)
    }
  } catch { return { projects: [] } }

  return {
    home: homedir(),
    projects: [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cwd, ts]) => ({ cwd, last_active: new Date(ts).toISOString() }))
  }
})

app.get('/models', {
  schema: {
    tags: ['discovery'],
    summary: 'List available Anthropic models from the live API',
    response: {
      200: {
        type: 'object',
        properties: {
          models: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
          },
        },
      },
      502: S.error,
      503: S.error,
    },
  },
}, async (_req, reply) => {
  const token = scheduler.readKeychainToken()
  if (!token) return reply.code(503).send({ error: 'no auth token' })
  try {
    const res  = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'Authorization': `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(8000),
    })
    const data = await res.json() as { data: { id: string; display_name: string }[] }
    return { models: data.data.map(m => ({ id: m.id, name: m.display_name })) }
  } catch (e) {
    return reply.code(502).send({ error: (e as Error).message })
  }
})

// ── Queue ──────────────────────────────────────────────────────────────────────

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
    summary: 'List tasks with pagination',
    querystring: {
      type: 'object',
      properties: {
        limit:  { type: 'integer', default: 25, minimum: 1, maximum: 100 },
        offset: { type: 'integer', default: 0,  minimum: 0 },
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
  return { tasks: db.getTasks(limit, offset), total: db.getTaskCount() }
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
        description: { type: 'string' },
        cwd:         { type: 'string' },
        model:       { type: 'string' },
        provider_id: { type: 'integer' },
        schedule:    { type: 'string', enum: ['once','hourly','daily','weekly','monthly'], default: 'once' },
      },
    },
    response: {
      200: { type: 'object', properties: { ok: { type: 'boolean' }, task: S.task } },
      400: S.error,
    },
  },
}, async (req, reply) => {
  const { description, cwd, model, provider_id, schedule } =
    req.body as { description?: string; cwd?: string; model?: string; provider_id?: number; schedule?: db.TaskSchedule }
  if (!description?.trim()) return reply.code(400).send({ error: 'description required' })
  const task = db.addTask(description.trim(), cwd?.trim(), model?.trim(), provider_id, schedule || 'once')
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

// ── Start ──────────────────────────────────────────────────────────────────────

function startScheduleChecker(): void {
  setInterval(() => {
    const due = db.getScheduledDueTasks()
    for (const task of due) {
      db.setTaskPending(task.id)
      enqueueTask(task)
      app.log.info(`[schedule] enqueued #${task.id} (${task.schedule})`)
    }
  }, 60_000)
}

db.migrate()
await app.listen({ host: '0.0.0.0', port: PORT })
app.log.info(`[restwalker] running on http://localhost:${PORT}`)
app.log.info(`[restwalker] watching ${scheduler.USAGE_CACHE}`)
startPoller()
startScheduleChecker()
setQueue(startQueue(msg => app.log.info(msg)))

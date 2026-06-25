import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import chokidar from 'chokidar'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { createWriteStream } from 'fs'

import * as db from './db.js'
import * as scheduler from './scheduler.js'
import { startQueue, setQueue, enqueueTask, forceRunNext } from './runner.js'
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

await app.register(fastifyStatic, {
  root: join(__dirname, '..'),
  serve: false,
})

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

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get('/healthz', async () => ({ ok: true }))

app.get('/', async (_req, reply) => reply.sendFile('index.html'))

app.post('/sync', async () => {
  const cfg    = db.getSettings()
  const staleS = parseFloat(cfg.CACHE_STALE_MIN) * 60
  const usage  = await scheduler.readUsage({ cacheStaleS: staleS, forceRefresh: true })
  if (usage && !usage.stale) {
    db.recordSnapshot(usage.five_hour_pct, usage.weekly_pct, usage.weekly_resets_at)
    app.log.info(`[sync] 5h=${usage.five_hour_pct.toFixed(1)}% weekly=${usage.weekly_pct.toFixed(1)}% source=${usage.source}`)
  }
  return { ok: true, stale: usage?.stale ?? true }
})

app.get('/can-run', async (req) => {
  const project = (req.query as Record<string, string>).project ?? 'default'
  const cfg     = db.getSettings()
  const staleS  = parseFloat(cfg.CACHE_STALE_MIN) * 60
  const usage   = await scheduler.readUsage({ cacheStaleS: staleS })
  const result  = await scheduler.canRun(usage, cfg)
  app.log.info(`[can-run] project=${project} ok=${result.ok} reason=${result.reason}`)
  return result
})

app.get('/status', async () => {
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

app.get('/history', async (req) => {
  const hours = parseInt((req.query as Record<string, string>).hours ?? '48')
  return { history: db.usageHistory(hours) }
})

app.get('/settings', async () => db.getSettings())

app.post('/settings', async (req, reply) => {
  try {
    db.updateSettings(req.body as Partial<Settings>)
    return { ok: true, settings: db.getSettings() }
  } catch (e) {
    return reply.code(422).send({ error: (e as Error).message })
  }
})

// ── Queue routes ───────────────────────────────────────────────────────────────

app.get('/queue/stats', async () => db.queueStats())

app.get('/queue', async (req) => {
  const limit = parseInt((req.query as Record<string, string>).limit ?? '50')
  return { tasks: db.getTasks(limit) }
})

app.get('/queue/:id', async (req, reply) => {
  const task = db.getTask(parseInt((req.params as { id: string }).id))
  if (!task) return reply.code(404).send({ error: 'not found' })
  return task
})

app.post('/queue', async (req, reply) => {
  const { description, cwd } = req.body as { description?: string; cwd?: string }
  if (!description?.trim()) return reply.code(400).send({ error: 'description required' })
  const task = db.addTask(description.trim(), cwd?.trim())
  enqueueTask(task)
  app.log.info(`[queue] added #${task.id}: ${description.slice(0, 80)}`)
  return { ok: true, task }
})

app.delete('/queue/:id', async (req, reply) => {
  const id   = parseInt((req.params as { id: string }).id)
  const task = db.getTask(id)
  if (!task) return reply.code(404).send({ error: 'not found' })
  if (task.status !== 'pending') return reply.code(409).send({ error: 'can only cancel pending tasks' })
  db.cancelTask(id)
  return { ok: true }
})

app.post('/queue/force-run', async () => {
  return forceRunNext(msg => app.log.info(msg))
})

app.get('/queue/skills', async (req) => {
  const limit = parseInt((req.query as Record<string, string>).limit ?? '20')
  return { skills: db.getSkills(limit) }
})

// ── Start ──────────────────────────────────────────────────────────────────────

db.migrate()
await app.listen({ host: '0.0.0.0', port: PORT })
app.log.info(`[restwalker] running on http://localhost:${PORT}`)
app.log.info(`[restwalker] watching ${scheduler.USAGE_CACHE}`)
startPoller()
setQueue(startQueue(msg => app.log.info(msg)))

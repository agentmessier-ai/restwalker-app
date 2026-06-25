import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import chokidar from 'chokidar'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { createWriteStream } from 'fs'

import * as db from './db.js'
import * as scheduler from './scheduler.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT      = parseInt(process.env.PORT ?? '47290')
const LOG_FILE  = process.env.RESTWALKER_LOG ?? join(homedir(), '.restwalker', 'restwalker.log')

const app = Fastify({
  logger: {
    level: 'info',
    stream: createWriteStream(LOG_FILE, { flags: 'a' }),
  },
  disableRequestLogging: true,  // suppress per-request noise; app logs key events manually
})

// Serve index.html from parent directory (shared with Python version)
await app.register(fastifyStatic, {
  root: join(__dirname, '..'),
  serve: false,
})

// ── Sync helper ────────────────────────────────────────────────────────────────

async function doSync({ forceRefresh = false } = {}) {
  const cfg    = db.getSettings()
  const staleS = parseFloat(cfg.CACHE_STALE_MIN ?? 30) * 60
  const usage  = await scheduler.readUsage({ cacheStaleS: staleS, forceRefresh })
  if (usage && !usage.stale) {
    db.recordSnapshot(usage.five_hour_pct, usage.weekly_pct, usage.weekly_resets_at)
    app.log.info(`[sync] 5h=${usage.five_hour_pct.toFixed(1)}% weekly=${usage.weekly_pct.toFixed(1)}% source=${usage.source}`)
  }
  return usage
}

// ── File watcher ───────────────────────────────────────────────────────────────

const watcher = chokidar.watch(scheduler.USAGE_CACHE, { persistent: true, ignoreInitial: true })
watcher.on('change', () => {
  app.log.info('[watcher] cache file changed — syncing')
  doSync().catch(e => app.log.warn('[watcher] sync error: ' + e.message))
})

// ── Background poller ──────────────────────────────────────────────────────────

function startPoller() {
  const cfg        = db.getSettings()
  const intervalMs = parseFloat(cfg.POLL_INTERVAL_MIN ?? 5) * 60_000
  setTimeout(async () => {
    await doSync({ forceRefresh: true }).catch(e => app.log.warn('[poller] ' + e.message))
    startPoller()  // reschedule so interval picks up setting changes
  }, intervalMs)
}

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get('/healthz', async () => ({ ok: true }))

app.get('/', async (req, reply) => reply.sendFile('index.html'))

app.post('/sync', async () => {
  const cfg    = db.getSettings()
  const staleS = parseFloat(cfg.CACHE_STALE_MIN ?? 30) * 60
  const usage  = await scheduler.readUsage({ cacheStaleS: staleS, forceRefresh: true })
  if (usage && !usage.stale) {
    db.recordSnapshot(usage.five_hour_pct, usage.weekly_pct, usage.weekly_resets_at)
    app.log.info(`[sync] 5h=${usage.five_hour_pct.toFixed(1)}% weekly=${usage.weekly_pct.toFixed(1)}% source=${usage.source}`)
  }
  return { ok: true, stale: usage?.stale ?? true }
})

app.get('/can-run', async (req) => {
  const project = req.query.project ?? 'default'
  const cfg     = db.getSettings()
  const staleS  = parseFloat(cfg.CACHE_STALE_MIN ?? 30) * 60
  const usage   = await scheduler.readUsage({ cacheStaleS: staleS })
  const result  = await scheduler.canRun(usage, cfg)
  app.log.info(`[can-run] project=${project} ok=${result.ok} reason=${result.reason}`)
  return result
})

app.get('/status', async () => {
  const cfg    = db.getSettings()
  const staleS = parseFloat(cfg.CACHE_STALE_MIN ?? 30) * 60
  const now    = new Date()
  const usage  = await scheduler.readUsage({ cacheStaleS: staleS })
  const decision = await scheduler.canRun(usage, cfg)
  const snap   = db.latestSnapshot()

  const startH = parseInt(cfg.CODING_START_H ?? 16)
  const endH   = parseInt(cfg.CODING_END_H   ?? 2)
  const tz     = cfg.TIMEZONE ?? 'America/Los_Angeles'

  return {
    window:         scheduler.isCodingWindow(now, startH, endH, tz) ? 'coding' : 'idle',
    next_idle_in_s: scheduler.nextIdleInS(now, startH, endH, tz),
    ok:             decision.ok,
    provider:       decision.provider ?? null,
    reason:         decision.reason,
    usage: {
      five_hour_pct:    usage?.five_hour_pct ?? null,
      weekly_pct:       usage?.weekly_pct    ?? null,
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
      five_hour_pause_pct:  parseFloat(cfg.FIVE_HOUR_PAUSE_PCT  ?? 75),
      weekly_reserve_pct:   parseFloat(cfg.WEEKLY_RESERVE_PCT   ?? 35),
      weekly_hard_stop_pct: parseFloat(cfg.WEEKLY_HARD_STOP_PCT ?? 90),
      cache_stale_min:      parseFloat(cfg.CACHE_STALE_MIN      ?? 30),
      poll_interval_min:    parseFloat(cfg.POLL_INTERVAL_MIN    ?? 5),
    },
  }
})

app.get('/history', async (req) => {
  const hours = parseInt(req.query.hours ?? 48)
  return { history: db.usageHistory(hours) }
})

app.get('/settings', async () => db.getSettings())

app.post('/settings', async (req, reply) => {
  try {
    db.updateSettings(req.body)
    return { ok: true, settings: db.getSettings() }
  } catch (e) {
    return reply.code(422).send({ error: e.message })
  }
})

// ── Start ──────────────────────────────────────────────────────────────────────

db.migrate()
await app.listen({ host: '0.0.0.0', port: PORT })
app.log.info(`[restwalker] node version running on http://localhost:${PORT}`)
app.log.info(`[restwalker] watching ${scheduler.USAGE_CACHE}`)
startPoller()

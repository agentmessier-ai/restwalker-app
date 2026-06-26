import type { FastifyInstance } from 'fastify'
import * as db from '../db.js'
import * as scheduler from '../scheduler.js'

export async function doSync(app: FastifyInstance, { forceRefresh = false } = {}): Promise<void> {
  const cfg    = db.getSettings()
  const staleS = parseFloat(cfg.CACHE_STALE_MIN) * 60
  const usage  = await scheduler.readUsage({ cacheStaleS: staleS, forceRefresh })
  if (usage && !usage.stale) {
    db.recordSnapshot(usage.five_hour_pct, usage.weekly_pct, usage.weekly_resets_at)
    app.log.info(`[sync] 5h=${usage.five_hour_pct.toFixed(1)}% weekly=${usage.weekly_pct.toFixed(1)}% source=${usage.source}`)
  }
}

export default async function usageRoutes(app: FastifyInstance) {
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
                coding_window_enabled: { type: 'boolean' },
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
      window:         cfg.CODING_WINDOW_ENABLED === '1' && scheduler.isCodingWindow(now, startH, endH, tz) ? 'coding' : 'idle',
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
        coding_window_enabled: cfg.CODING_WINDOW_ENABLED === '1',
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

  app.get('/meta', {
    schema: {
      tags: ['utility'],
      summary: 'Daemon metadata',
      response: {
        200: {
          type: 'object',
          properties: {
            installPath: { type: 'string' },
            nodeVersion:  { type: 'string' },
            port:         { type: 'integer' },
            logPath:      { type: 'string' },
          },
        },
      },
    },
  }, async () => {
    // These values come from app.ts via the app instance's custom decoration,
    // but since we can't easily pass them here without decoration, we read from env/process
    const PORT     = parseInt(process.env.PORT ?? '47290')
    const { homedir } = await import('os')
    const { join } = await import('path')
    const LOG_FILE = process.env.RESTWALKER_LOG ?? join(homedir(), '.restwalker', 'restwalker.log')
    // installPath: go up from routes/ -> node/ -> repo root
    const { dirname } = await import('path')
    const { fileURLToPath } = await import('url')
    // We can't use import.meta.url from a plugin loaded via register the same way,
    // but we can resolve via the app's root path stored on options or just use process.cwd()
    // The original used __dirname (node/) parent = repo root
    // Here we use the same pattern with import.meta.url
    return {
      installPath: join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
      nodeVersion: process.version,
      port: PORT,
      logPath: LOG_FILE,
    }
  })
}

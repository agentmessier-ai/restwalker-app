import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import chokidar from 'chokidar'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { createWriteStream } from 'fs'

import * as db from './db.js'
import * as scheduler from './scheduler.js'
import { startQueue, setQueue, enqueueTask, setLogger as setRunnerLogger } from './runner.js'
import { setLogger as setSchedulerLogger } from './scheduler.js'
import { plugins } from './plugins.js'
import { gbrainPlugin } from './plugins/gbrain-plugin.js'
import { webhookPlugin, setLogger as setWebhookLogger } from './plugins/webhook.js'
import { setLogger as setGbrainLogger } from './gbrain.js'

import healthRoutes       from './routes/health.js'
import usageRoutes, { doSync } from './routes/usage.js'
import settingsRoutes     from './routes/settings.js'
import providersRoutes    from './routes/providers.js'
import queueRoutes        from './routes/queue.js'
import systemPromptRoutes from './routes/system-prompt.js'
import taskPromptsRoutes  from './routes/task-prompts.js'
import utilityRoutes      from './routes/utility.js'
import pluginRoutes       from './routes/plugins.js'
import teleportRoutes     from './routes/teleport.js'
import { startMdns, setLogger as setMdnsLogger } from './teleport-mdns.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT      = parseInt(process.env.PORT ?? '47290')
// Bind localhost by default — this service can run arbitrary Bash via tasks, so it
// must not be reachable from the LAN unless the operator explicitly opts in by
// setting HOST=0.0.0.0 in the LaunchAgent plist's EnvironmentVariables.
const HOST      = process.env.HOST ?? '127.0.0.1'
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
      { name: 'health',        description: 'Health and status' },
      { name: 'usage',         description: 'Claude usage monitoring and sync' },
      { name: 'settings',      description: 'Daemon configuration' },
      { name: 'providers',     description: 'Agent provider management' },
      { name: 'queue',         description: 'Task queue' },
      { name: 'discovery',     description: 'Models and projects' },
      { name: 'system-prompt', description: 'Versioned system prompt management' },
      { name: 'task-prompts',  description: 'Versioned task prompt objects' },
      { name: 'utility',       description: 'Utility endpoints' },
      { name: 'plugins',       description: 'Plugin management' },
      { name: 'teleport',      description: 'Cross-folder / cross-Mac conversation retrieval' },
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

// ── Routes ─────────────────────────────────────────────────────────────────────

await app.register(healthRoutes)
await app.register(usageRoutes)
await app.register(settingsRoutes)
await app.register(providersRoutes)
await app.register(queueRoutes)
await app.register(systemPromptRoutes)
await app.register(taskPromptsRoutes)
await app.register(utilityRoutes)
await app.register(pluginRoutes)
await app.register(teleportRoutes)

// ── File watcher ───────────────────────────────────────────────────────────────

const watcher = chokidar.watch(scheduler.USAGE_CACHE, { persistent: true, ignoreInitial: true })
watcher.on('change', () => {
  app.log.info('[watcher] cache file changed — syncing')
  doSync(app).catch((e: Error) => app.log.warn('[watcher] sync error: ' + e.message))
})

// ── Background poller ──────────────────────────────────────────────────────────

function startPoller(): void {
  const cfg        = db.getSettings()
  const intervalMs = parseFloat(cfg.POLL_INTERVAL_MIN) * 60_000
  setTimeout(async () => {
    await doSync(app, { forceRefresh: true }).catch((e: Error) => app.log.warn('[poller] ' + e.message))
    startPoller()
  }, intervalMs)
}

// ── Schedule checker ───────────────────────────────────────────────────────────

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

// ── Start ──────────────────────────────────────────────────────────────────────

db.migrate()
const orphans = db.resetOrphanedTasks()
if (orphans > 0) app.log.warn(`[boot] reset ${orphans} orphaned running task(s) to pending`)
await app.listen({ host: HOST, port: PORT })
const shown = HOST === '0.0.0.0' ? 'localhost' : HOST
app.log.info(`[restwalker] running on http://${shown}:${PORT} (bound ${HOST})`)
if (HOST === '0.0.0.0') app.log.warn('[restwalker] bound to 0.0.0.0 — reachable from the LAN; this service can run Bash, ensure the network is trusted')
app.log.info(`[restwalker] watching ${scheduler.USAGE_CACHE}`)
startPoller()
startScheduleChecker()
setQueue(startQueue(msg => app.log.info(msg)))
setRunnerLogger({ info: (s) => app.log.info(s), warn: (s) => app.log.warn(s) })
setSchedulerLogger({ info: (s) => app.log.info(s), warn: (s) => app.log.warn(s) })
plugins.setLogger({ info: (s) => app.log.info(s), warn: (s) => app.log.warn(s) })
setGbrainLogger({ info: (s) => app.log.info(s), warn: (s) => app.log.warn(s) })
setWebhookLogger({ info: (s) => app.log.info(s), warn: (s) => app.log.warn(s) })
plugins.register(webhookPlugin, { builtin: true })
plugins.register(gbrainPlugin, { builtin: true })
await plugins.loadPersistedExternal()

// Teleport LAN discovery — opt-in. Cross-folder teleport works regardless; this
// only advertises/browses the network when explicitly enabled.
setMdnsLogger({ info: (s) => app.log.info(s), warn: (s) => app.log.warn(s) })
if (db.getSettings().TELEPORT_NETWORK_ENABLED === '1') {
  startMdns(PORT, process.env.npm_package_version ?? 'dev')
} else {
  app.log.info('[teleport] cross-folder enabled; network discovery off (TELEPORT_NETWORK_ENABLED=0)')
}

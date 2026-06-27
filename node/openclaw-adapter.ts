import { readFileSync, existsSync, writeFileSync } from 'fs'
import { join, dirname, resolve as pathResolve } from 'path'
import { createRequire } from 'module'
import { homedir } from 'os'
import type { Plugin, PluginContext, PreTaskContext, PostTaskContext, OnArtifactContext, OnIdleContext, OnTurnContext, OnToolCallContext, OnToolResultContext, OnMessageContext, HookName } from './plugins.js'

const _require = createRequire(import.meta.url)

// ── OpenClaw manifest ──────────────────────────────────────────────────────────

export interface OpenClawManifest {
  id: string
  description?: string
  version?: string
  configSchema?: Record<string, unknown>
  providers?: string[]
  channels?: string[]
  contracts?: string[]
}

// ── OpenClaw plugin definition (what plugins export as default) ────────────────

export interface OpenClawPluginDefinition {
  id: string
  register(api: OpenClawPluginApi): void | Promise<void>
}

// ── OpenClaw plugin API (what we provide to plugins) ──────────────────────────

export interface OpenClawPluginApi {
  registerHook(hookName: string, handler: (ctx: unknown) => unknown | Promise<unknown>): void
  registerTool(name: string, def: unknown): void
  registerCommand(name: string, handler: unknown, opts?: unknown): void
  registerMiddleware(kind: string, handler: unknown): void
  registerMemoryProvider(name: string, provider: unknown): void
  registerPlatform(name: string, platform: unknown): void
  registerSkill(name: string, path: string): void
  log: {
    info(msg: string): void
    warn(msg: string): void
    error(msg: string): void
    debug(msg: string): void
  }
  config: Record<string, unknown>
  version: string
  hostVersion: string
}

// ── Hook mapping: OpenClaw hook name → restwalker HookName(s) ─────────────────

const HOOK_MAP: Record<string, HookName[]> = {
  before_agent_run:       ['pre_task'],
  agent_turn_prepare:     ['on_turn'],
  before_prompt_build:    ['pre_task'],
  session_start:          ['pre_task'],
  before_agent_reply:     ['on_message'],
  before_agent_finalize:  ['post_task'],
  agent_end:              ['post_task'],
  session_end:            ['post_task'],
  before_tool_call:       ['on_tool_call'],
  after_tool_call:        ['on_tool_result'],
  tool_result_persist:    ['on_tool_result'],
  gateway_start:          ['on_idle'],
  gateway_stop:           ['on_idle'],
  // still no-op
  before_model_resolve:   [],
  resolve_exec_env:       [],
  inbound_claim:          [],
  message_received:       [],
  message_sending:        [],
  reply_dispatch:         [],
  message_sent:           [],
  before_compaction:      [],
  after_compaction:       [],
  before_reset:           [],
  subagent_spawned:       [],
  subagent_ended:         [],
  subagent_delivery_target: [],
  cron_changed:           [],
  before_install:         [],
}

// ── Context translators ────────────────────────────────────────────────────────

function toPreTaskCtx(ctx: PreTaskContext): unknown {
  return {
    agentId:       String(ctx.task.id),
    prompt:        ctx.task.description,
    model:         ctx.task.model,
    workspacePath: ctx.workspacePath,
    sessionPath:   ctx.workspacePath,
    task: {
      id:          ctx.task.id,
      description: ctx.task.description,
      schedule:    ctx.task.schedule,
      cwd:         ctx.task.cwd,
    },
  }
}

function toPostTaskCtx(ctx: PostTaskContext): unknown {
  return {
    agentId:       String(ctx.task.id),
    status:        ctx.status === 'done' ? 'success' : 'error',
    tokensUsed:    ctx.tokensUsed,
    toolCalls:     ctx.toolCalls,
    result:        ctx.result,
    workspacePath: ctx.workspacePath,
    task: {
      id:          ctx.task.id,
      description: ctx.task.description,
      schedule:    ctx.task.schedule,
    },
  }
}

function toArtifactCtx(ctx: OnArtifactContext): unknown {
  return {
    toolName:   'write_file',
    toolResult: {
      path:        ctx.artifactPath,
      description: ctx.description,
      mimeType:    ctx.mimeType,
    },
    task: {
      id:          ctx.task.id,
      description: ctx.task.description,
    },
  }
}

function toIdleCtx(ctx: OnIdleContext): unknown {
  return {
    event:  'gateway_idle',
    reason: ctx.reason,
  }
}

function toToolCallCtx(ctx: OnToolCallContext): unknown {
  return { toolName: ctx.tool, toolInput: ctx.input, callId: ctx.callId, task: { id: ctx.task.id } }
}

function toToolResultCtx(ctx: OnToolResultContext): unknown {
  return { toolName: ctx.tool, callId: ctx.callId, result: ctx.result, isError: ctx.isError, task: { id: ctx.task.id } }
}

function toTurnCtx(ctx: OnTurnContext): unknown {
  return { turn: ctx.turn, inputTokens: ctx.inputTokens, task: { id: ctx.task.id } }
}

function toMessageCtx(ctx: OnMessageContext): unknown {
  return { content: ctx.content, thinking: ctx.thinking, task: { id: ctx.task.id } }
}

// ── Logger ────────────────────────────────────────────────────────────────────

let _log = { info: console.log, warn: console.warn }
export function setLogger(l: typeof _log) { _log = l }

// ── Adapter: wrap OpenClaw plugin as restwalker Plugin ─────────────────────────

export function adaptOpenClawPlugin(
  def: OpenClawPluginDefinition,
  manifest: OpenClawManifest
): Plugin {
  const pluginName = manifest.id ?? def.id

  return {
    name: pluginName,
    register(ctx: PluginContext) {
      const mapped: string[] = []
      const noOp:   string[] = []

      const api: OpenClawPluginApi = {
        registerHook(hookName, handler) {
          const targets = HOOK_MAP[hookName]
          if (targets === undefined) {
            _log.warn(`[openclaw:${pluginName}] unknown hook "${hookName}" — ignored`)
            return
          }
          if (targets.length === 0) {
            noOp.push(hookName)
            return
          }
          mapped.push(hookName)
          for (const rwHook of targets) {
            if (rwHook === 'pre_task') {
              ctx.on('pre_task', async (rwCtx) => { await handler(toPreTaskCtx(rwCtx)) })
            } else if (rwHook === 'post_task') {
              ctx.on('post_task', async (rwCtx) => { await handler(toPostTaskCtx(rwCtx)) })
            } else if (rwHook === 'on_artifact') {
              ctx.on('on_artifact', async (rwCtx) => { await handler(toArtifactCtx(rwCtx)) })
            } else if (rwHook === 'on_idle') {
              ctx.on('on_idle', async (rwCtx) => { await handler(toIdleCtx(rwCtx)) })
            } else if (rwHook === 'on_turn') {
              ctx.on('on_turn', async (rwCtx) => { await handler(toTurnCtx(rwCtx)) })
            } else if (rwHook === 'on_tool_call') {
              ctx.on('on_tool_call', async (rwCtx) => { await handler(toToolCallCtx(rwCtx)) })
            } else if (rwHook === 'on_tool_result') {
              ctx.on('on_tool_result', async (rwCtx) => { await handler(toToolResultCtx(rwCtx)) })
            } else if (rwHook === 'on_message') {
              ctx.on('on_message', async (rwCtx) => { await handler(toMessageCtx(rwCtx)) })
            }
          }
        },
        registerTool(name, _def) {
          _log.info(`[openclaw:${pluginName}] registerTool("${name}") — noted, restwalker tools are agent-side`)
        },
        registerCommand(name, _handler, _opts) {
          _log.info(`[openclaw:${pluginName}] registerCommand("${name}") — no-op in restwalker`)
        },
        registerMiddleware(_kind, _handler) {},
        registerMemoryProvider(_name, _provider) {},
        registerPlatform(_name, _platform) {},
        registerSkill(_name, _path) {},
        log: {
          info:  (m) => _log.info(`[openclaw:${pluginName}] ${m}`),
          warn:  (m) => _log.warn(`[openclaw:${pluginName}] ${m}`),
          error: (m) => _log.warn(`[openclaw:${pluginName}] ERROR: ${m}`),
          debug: (_m) => {},
        },
        config:      {},
        version:     manifest.version ?? '0.0.0',
        hostVersion: '1.0.0',
      }

      const result = def.register(api) as unknown
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((e: Error) =>
          _log.warn(`[openclaw:${pluginName}] async register() error: ${e.message}`)
        )
      }

      if (mapped.length) _log.info(`[openclaw:${pluginName}] mapped hooks: ${mapped.join(', ')}`)
      if (noOp.length)   _log.info(`[openclaw:${pluginName}] no-op hooks: ${noOp.join(', ')}`)
    },
  }
}

// ── Loader: resolve package → manifest + plugin definition ────────────────────

export interface LoadedOpenClawPlugin {
  plugin:   Plugin
  manifest: OpenClawManifest
  path:     string
}

export async function loadOpenClawPlugin(pathOrPackage: string): Promise<LoadedOpenClawPlugin> {
  let pkgDir: string

  if (pathOrPackage.startsWith('/') || pathOrPackage.startsWith('./') || pathOrPackage.startsWith('../')) {
    pkgDir = pathResolve(pathOrPackage)
  } else {
    const pkgJsonPath = _require.resolve(`${pathOrPackage}/package.json`)
    pkgDir = dirname(pkgJsonPath)
  }

  const manifestPath = join(pkgDir, 'openclaw.plugin.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`No openclaw.plugin.json found in ${pkgDir}`)
  }
  const manifest: OpenClawManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!manifest.id) throw new Error(`openclaw.plugin.json must have an "id" field`)

  const pkgJsonPath2 = join(pkgDir, 'package.json')
  if (!existsSync(pkgJsonPath2)) throw new Error(`No package.json found in ${pkgDir}`)
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath2, 'utf8'))

  const extensionsRel: string | undefined =
    pkgJson?.openclaw?.extensions ?? pkgJson.main ?? pkgJson.exports?.['.']
  if (!extensionsRel) {
    throw new Error(`Cannot find extensions entrypoint in ${pkgDir}/package.json (set openclaw.extensions, main, or exports['.'])`)
  }
  const extensionsPath = join(pkgDir, extensionsRel)

  const mod = await import(extensionsPath) as { default?: OpenClawPluginDefinition; plugin?: OpenClawPluginDefinition }
  const def: OpenClawPluginDefinition | undefined = mod.default ?? mod.plugin
  if (!def || typeof def.register !== 'function') {
    throw new Error(`${extensionsPath} must export a default object with register(api)`)
  }

  const plugin = adaptOpenClawPlugin(def, manifest)
  return { plugin, manifest, path: pkgDir }
}

// ── Persistence helpers ────────────────────────────────────────────────────────

const PLUGINS_FILE = join(homedir(), '.restwalker', 'plugins.json')

interface PluginsPersisted {
  disabled: string[]
  external: { name: string; path: string; openclaw?: boolean }[]
}

function loadPersisted(): PluginsPersisted {
  if (!existsSync(PLUGINS_FILE)) return { disabled: [], external: [] }
  try { return JSON.parse(readFileSync(PLUGINS_FILE, 'utf8')) }
  catch { return { disabled: [], external: [] } }
}

export function persistOpenClawEntry(name: string, resolvedPath: string): void {
  const persisted = loadPersisted()
  if (!persisted.external.find(e => e.path === resolvedPath)) {
    persisted.external.push({ name, path: resolvedPath, openclaw: true })
    try { writeFileSync(PLUGINS_FILE, JSON.stringify(persisted, null, 2), 'utf8') }
    catch { /* best-effort */ }
  }
}

// ── Reload persisted OpenClaw plugins on startup ───────────────────────────────

export async function reloadPersistedOpenClaw(
  manager: { register(plugin: Plugin, opts: { builtin: boolean; path: string | null; openclaw?: boolean }): unknown }
): Promise<void> {
  const persisted = loadPersisted()
  for (const entry of persisted.external.filter(e => e.openclaw)) {
    try {
      const { plugin } = await loadOpenClawPlugin(entry.path)
      manager.register(plugin, { builtin: false, path: entry.path, openclaw: true })
    } catch (e) {
      console.warn(`[openclaw] failed to reload ${entry.path}: ${(e as Error).message}`)
    }
  }
}

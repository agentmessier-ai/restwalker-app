import { Task } from './db.js'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { homedir } from 'os'

// ── Hook types ─────────────────────────────────────────────────────────────────

export interface PreTaskContext  { task: Task; workspacePath: string }
export interface PostTaskContext { task: Task; workspacePath: string; status: 'done' | 'failed'; tokensUsed: number; toolCalls: number; result: string }
export interface OnArtifactContext { task: Task; artifactPath: string; description: string; mimeType: string }
export interface OnIdleContext   { reason: string }

export interface OnTurnContext {
  task:        Task
  turn:        number
  inputTokens: number
}

export interface OnToolCallContext {
  task:   Task
  tool:   string
  input:  Record<string, unknown>
  callId: string
}

export interface OnToolResultContext {
  task:    Task
  tool:    string
  callId:  string
  result:  string
  isError: boolean
}

export interface OnMessageContext {
  task:      Task
  content:   string
  thinking?: string
}

export type HookName = 'pre_task' | 'post_task' | 'on_artifact' | 'on_idle'
  | 'on_turn' | 'on_tool_call' | 'on_tool_result' | 'on_message'
type HookHandler<T> = (ctx: T) => Promise<void> | void

// ── Plugin interface ───────────────────────────────────────────────────────────

export interface PluginContext {
  on(hook: 'pre_task',       handler: HookHandler<PreTaskContext>):       void
  on(hook: 'post_task',      handler: HookHandler<PostTaskContext>):      void
  on(hook: 'on_artifact',    handler: HookHandler<OnArtifactContext>):    void
  on(hook: 'on_idle',        handler: HookHandler<OnIdleContext>):        void
  on(hook: 'on_turn',        handler: HookHandler<OnTurnContext>):        void
  on(hook: 'on_tool_call',   handler: HookHandler<OnToolCallContext>):    void
  on(hook: 'on_tool_result', handler: HookHandler<OnToolResultContext>):  void
  on(hook: 'on_message',     handler: HookHandler<OnMessageContext>):     void
}

export interface PluginSetting {
  label:       string
  default:     string | boolean | number
  sensitive?:  boolean
  placeholder?: string
}

export interface Plugin {
  name:      string
  settings?: Record<string, PluginSetting>
  register(ctx: PluginContext, config: Record<string, unknown>): void
}

export interface PluginEntry {
  name:     string
  enabled:  boolean
  builtin:  boolean
  openclaw: boolean
  hooks:    HookName[]
  error:    string | null
  path:     string | null
  settings: Record<string, PluginSetting> | null
  config:   Record<string, unknown>
}

// ── Persistence ────────────────────────────────────────────────────────────────

const PLUGINS_FILE = join(homedir(), '.restwalker', 'plugins.json')

interface PluginsPersisted {
  disabled: string[]
  external: { name: string; path: string }[]
  config:   Record<string, Record<string, unknown>>
}

function loadPersisted(): PluginsPersisted {
  if (!existsSync(PLUGINS_FILE)) return { disabled: [], external: [], config: {} }
  try {
    const d = JSON.parse(readFileSync(PLUGINS_FILE, 'utf8'))
    return { disabled: d.disabled ?? [], external: d.external ?? [], config: d.config ?? {} }
  }
  catch { return { disabled: [], external: [], config: {} } }
}

function savePersisted(data: PluginsPersisted): void {
  try { writeFileSync(PLUGINS_FILE, JSON.stringify(data, null, 2), 'utf8') }
  catch { /* best-effort */ }
}

// ── Plugin manager ─────────────────────────────────────────────────────────────

interface PluginRecord {
  entry:    PluginEntry
  handlers: Map<HookName, HookHandler<any>[]>
}

class PluginManager {
  private records: Map<string, PluginRecord> = new Map()
  private _log: { info(s: string): void; warn(s: string): void } = { info: console.log, warn: console.warn }

  setLogger(l: typeof this._log) { this._log = l }

  register(plugin: Plugin, opts: { builtin?: boolean; path?: string | null; openclaw?: boolean } = {}): PluginEntry {
    const persisted = loadPersisted()
    const enabled   = !persisted.disabled.includes(plugin.name)
    const hooks: HookName[] = []
    const handlers  = new Map<HookName, HookHandler<any>[]>()

    // Resolve config: stored values override defaults
    const settings  = plugin.settings ?? null
    const stored    = persisted.config[plugin.name] ?? {}
    const config: Record<string, unknown> = {}
    if (settings) {
      for (const [key, field] of Object.entries(settings)) {
        config[key] = key in stored ? stored[key] : field.default
      }
    }

    const entry: PluginEntry = {
      name:     plugin.name,
      enabled,
      builtin:  opts.builtin ?? false,
      openclaw: opts.openclaw ?? false,
      hooks,
      error:    null,
      path:     opts.path ?? null,
      settings,
      config,
    }

    const ctx: PluginContext = {
      on: (hook: HookName, handler: HookHandler<any>) => {
        if (!hooks.includes(hook)) hooks.push(hook)
        const arr = handlers.get(hook) ?? []
        arr.push(handler)
        handlers.set(hook, arr)
      },
    }

    try {
      plugin.register(ctx, config)
      this._log.info(`[plugins] registered: ${plugin.name}${enabled ? '' : ' (disabled)'}`)
    } catch (e) {
      entry.error = (e as Error).message
      this._log.warn(`[plugins] failed to register ${plugin.name}: ${entry.error}`)
    }

    this.records.set(plugin.name, { entry, handlers })
    return entry
  }

  saveConfig(name: string, values: Record<string, unknown>): void {
    const rec = this.records.get(name)
    if (!rec) throw new Error(`plugin "${name}" not found`)
    const p = loadPersisted()
    p.config[name] = { ...(p.config[name] ?? {}), ...values }
    savePersisted(p)
    // Update live config so subsequent hook calls see new values
    Object.assign(rec.entry.config, values)
  }

  async loadExternal(filePath: string): Promise<PluginEntry> {
    const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath)
    const mod = await import(abs) as { default?: Plugin; plugin?: Plugin }
    const plugin: Plugin | undefined = mod.default ?? mod.plugin
    if (!plugin || typeof plugin.name !== 'string' || typeof plugin.register !== 'function') {
      throw new Error(`${filePath} must export a default Plugin object with { name, register() }`)
    }
    if (this.records.has(plugin.name)) {
      throw new Error(`plugin "${plugin.name}" is already registered`)
    }
    const entry = this.register(plugin, { builtin: false, path: abs })
    const persisted = loadPersisted()
    if (!persisted.external.find(e => e.path === abs)) {
      persisted.external.push({ name: plugin.name, path: abs })
      savePersisted(persisted)
    }
    return entry
  }

  disable(name: string): void {
    const rec = this.records.get(name)
    if (!rec) throw new Error(`plugin "${name}" not found`)
    rec.entry.enabled = false
    const p = loadPersisted()
    if (!p.disabled.includes(name)) p.disabled.push(name)
    savePersisted(p)
    this._log.info(`[plugins] disabled: ${name}`)
  }

  enable(name: string): void {
    const rec = this.records.get(name)
    if (!rec) throw new Error(`plugin "${name}" not found`)
    rec.entry.enabled = true
    const p = loadPersisted()
    p.disabled = p.disabled.filter(n => n !== name)
    savePersisted(p)
    this._log.info(`[plugins] enabled: ${name}`)
  }

  getAll(): PluginEntry[] {
    return [...this.records.values()].map(r => r.entry)
  }

  async invoke<T>(hook: HookName, ctx: T): Promise<void> {
    for (const { entry, handlers } of this.records.values()) {
      if (!entry.enabled) continue
      const arr = handlers.get(hook)
      if (!arr) continue
      for (const h of arr) {
        try { await h(ctx) }
        catch (e) { this._log.warn(`[plugins] ${hook} error in ${entry.name}: ${(e as Error).message}`) }
      }
    }
  }

  async loadPersistedExternal(): Promise<void> {
    const { external } = loadPersisted()
    for (const { path } of external) {
      try { await this.loadExternal(path) }
      catch (e) { this._log.warn(`[plugins] failed to reload external plugin from ${path}: ${(e as Error).message}`) }
    }
  }
}

export const plugins = new PluginManager()

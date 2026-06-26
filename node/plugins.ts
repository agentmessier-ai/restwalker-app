import { Task } from './db.js'

// ── Hook types ─────────────────────────────────────────────────────────────

export interface PreTaskContext {
  task: Task
  workspacePath: string
}

export interface PostTaskContext {
  task: Task
  workspacePath: string
  status: 'done' | 'failed'
  tokensUsed: number
  toolCalls: number
  result: string
}

export interface OnArtifactContext {
  task: Task
  artifactPath: string
  description: string
  mimeType: string
}

export interface OnIdleContext {
  reason: string   // why idle: 'gate_closed' | 'no_tasks' | 'window_closed'
}

export type HookName = 'pre_task' | 'post_task' | 'on_artifact' | 'on_idle'

type HookHandler<T> = (ctx: T) => Promise<void> | void

interface HookRegistry {
  pre_task:    HookHandler<PreTaskContext>[]
  post_task:   HookHandler<PostTaskContext>[]
  on_artifact: HookHandler<OnArtifactContext>[]
  on_idle:     HookHandler<OnIdleContext>[]
}

// ── Plugin interface ────────────────────────────────────────────────────────

export interface PluginContext {
  on(hook: 'pre_task',    handler: HookHandler<PreTaskContext>):    void
  on(hook: 'post_task',   handler: HookHandler<PostTaskContext>):   void
  on(hook: 'on_artifact', handler: HookHandler<OnArtifactContext>): void
  on(hook: 'on_idle',     handler: HookHandler<OnIdleContext>):     void
}

export interface Plugin {
  name: string
  register(ctx: PluginContext): void
}

// ── Plugin manager ──────────────────────────────────────────────────────────

class PluginManager {
  private hooks: HookRegistry = { pre_task: [], post_task: [], on_artifact: [], on_idle: [] }
  private _log: { info(s: string): void; warn(s: string): void } = { info: console.log, warn: console.warn }

  setLogger(l: typeof this._log) { this._log = l }

  register(plugin: Plugin): void {
    const ctx: PluginContext = {
      on: (hook: HookName, handler: HookHandler<any>) => {
        this.hooks[hook].push(handler)
      },
    }
    try {
      plugin.register(ctx)
      this._log.info(`[plugins] registered: ${plugin.name}`)
    } catch (e) {
      this._log.warn(`[plugins] failed to register ${plugin.name}: ${(e as Error).message}`)
    }
  }

  async invoke<T>(hook: HookName, ctx: T): Promise<void> {
    for (const handler of (this.hooks as any)[hook] as HookHandler<T>[]) {
      try {
        await handler(ctx)
      } catch (e) {
        this._log.warn(`[plugins] hook ${hook} error: ${(e as Error).message}`)
      }
    }
  }
}

export const plugins = new PluginManager()

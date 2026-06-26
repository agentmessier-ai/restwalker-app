import type { Task } from './db.js'

// ── Events emitted during a run ────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'turn_start';   turn: number; inputTokens: number }
  | { type: 'tool_call';    tool: string; input: Record<string, unknown>; callId: string }
  | { type: 'tool_result';  tool: string; callId: string; result: string; isError: boolean }
  | { type: 'message';      content: string; thinking?: string }
  | { type: 'artifact';     path: string; description: string }

// ── Context passed to every loop ─────────────────────────────────────────────

export interface AgentLoopContext {
  task:          Task
  workspacePath: string
  systemPrompt:  string
  model:         string
  extraContext?: string
  cwd:           string
}

// ── What every loop returns ───────────────────────────────────────────────────

export interface AgentLoopResult {
  result:      string
  tokensUsed:  number
  toolCalls:   number
  sessionId:   string | null
  sessionPath: string | null
  artifacts:   { path: string; description: string }[]
  tags:        string[]
}

// ── The interface every loop must implement ───────────────────────────────────

export type EventCallback = (event: AgentEvent) => Promise<void> | void

export interface AgentLoop {
  run(ctx: AgentLoopContext, onEvent: EventCallback): Promise<AgentLoopResult>
}

// ── Loop type identifier stored on providers ──────────────────────────────────
export type LoopType = 'claude_print' | 'claude_sdk' | 'custom'

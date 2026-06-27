import type { AgentLoop, LoopType } from '../agent-loop.js'
import { ClaudePrintLoop } from './claude-print.js'
import { ClaudeSDKLoop } from './claude-sdk.js'

export function createLoop(loopType: LoopType, timeoutMs: number): AgentLoop {
  switch (loopType) {
    case 'claude_print': return new ClaudePrintLoop(timeoutMs)
    case 'claude_sdk':   return new ClaudeSDKLoop()
    case 'custom':       return new ClaudePrintLoop(timeoutMs)
    default:             return new ClaudePrintLoop(timeoutMs)
  }
}

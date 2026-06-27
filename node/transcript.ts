// Shared parser for Claude Code session .jsonl transcripts. Each line is one JSON
// message; this normalizes the user/assistant + content-block shapes that session
// analysis (session.ts), teleport (teleport.ts), and the queue session view
// (routes/queue.ts) each used to re-parse by hand.
//
// Raw values (tool input, tool-result content) and the individual text/thinking
// BLOCKS are exposed so callers can format exactly as they did before — this is a
// normalization layer, not a reformatter. The live runner (loops/claude-print.ts)
// needs ordered streaming of blocks, so it keeps its own iteration.

export interface ToolUse    { id: string | null; name: string; input: unknown }
export interface ToolResult { id: string | null; content: unknown; is_error: boolean }

export interface TranscriptEntry {
  type:           'user' | 'assistant'
  ts:             string | null
  gitBranch:      string | null
  textBlocks:     string[]
  thinkingBlocks: string[]
  text:           string   // textBlocks.join('')
  thinking:       string   // thinkingBlocks.join('')
  toolUses:       ToolUse[]
  toolResults:    ToolResult[]
  usage:          { input_tokens: number; output_tokens: number }
}

// Parse one JSONL line into a normalized entry, or null for blank/malformed lines
// and non-user/assistant records (queue-operation, last-prompt, etc.).
export function parseTranscriptLine(line: string): TranscriptEntry | null {
  if (!line) return null
  let d: Record<string, unknown>
  try { d = JSON.parse(line) } catch { return null }

  const type = d.type
  if (type !== 'user' && type !== 'assistant') return null

  const msg = (d as { message?: { content?: unknown; usage?: { input_tokens?: number; output_tokens?: number } } }).message ?? {}
  const content = (msg as { content?: unknown }).content
  const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage ?? {}

  const textBlocks: string[] = []
  const thinkingBlocks: string[] = []
  const toolUses: ToolUse[] = []
  const toolResults: ToolResult[] = []

  if (typeof content === 'string') {
    textBlocks.push(content)
  } else if (Array.isArray(content)) {
    for (const c of content as Array<Record<string, unknown>>) {
      switch (c.type) {
        case 'text':        if (typeof c.text === 'string') textBlocks.push(c.text); break
        case 'thinking':    if (typeof c.thinking === 'string') thinkingBlocks.push(c.thinking); break
        case 'tool_use':    toolUses.push({ id: (c.id as string) ?? null, name: (c.name as string) ?? '?', input: c.input }); break
        case 'tool_result': toolResults.push({ id: (c.tool_use_id as string) ?? null, content: c.content, is_error: Boolean(c.is_error) }); break
      }
    }
  }

  return {
    type,
    ts:        typeof d.timestamp === 'string' ? d.timestamp : null,
    gitBranch: typeof d.gitBranch === 'string' ? d.gitBranch : null,
    textBlocks, thinkingBlocks,
    text:      textBlocks.join(''),
    thinking:  thinkingBlocks.join(''),
    toolUses, toolResults,
    usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 },
  }
}

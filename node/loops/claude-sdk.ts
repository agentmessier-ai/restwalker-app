import Anthropic from '@anthropic-ai/sdk'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AgentLoop, AgentLoopContext, AgentLoopResult, EventCallback } from '../agent-loop.js'

const ARTIFACT_RE = /^ARTIFACT:\s*(\{.+\})\s*$/m
const MAX_TURNS = 10

export class ClaudeSDKLoop implements AgentLoop {
  async run(ctx: AgentLoopContext, onEvent: EventCallback): Promise<AgentLoopResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

    const client = new Anthropic({ apiKey })

    const { task, workspacePath, systemPrompt, model, extraContext } = ctx
    const userContent = systemPrompt + (extraContext ?? '') + task.description

    let tokensUsed = 0
    let toolCalls = 0
    let turnCounter = 0
    let lastText = ''
    const transcript: string[] = []
    const artifacts: { path: string; description: string }[] = []

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userContent },
    ]

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.messages.create({
        model,
        max_tokens: 8192,
        system: systemPrompt,
        messages,
      })

      const inputTokens = response.usage?.input_tokens ?? 0
      const outputTokens = response.usage?.output_tokens ?? 0
      tokensUsed += inputTokens + outputTokens
      turnCounter++

      await onEvent({ type: 'turn_start', turn: turnCounter, inputTokens })

      let textAcc = ''

      for (const block of response.content) {
        if (block.type === 'text') {
          textAcc += block.text
          lastText = block.text
          transcript.push(block.text)

          // emit artifact events
          const re = new RegExp(ARTIFACT_RE.source, 'gm')
          let m: RegExpExecArray | null
          while ((m = re.exec(block.text)) !== null) {
            try {
              const decl = JSON.parse(m[1]) as { path?: string; description?: string }
              if (decl.path) {
                artifacts.push({ path: decl.path, description: decl.description ?? '' })
                await onEvent({ type: 'artifact', path: decl.path, description: decl.description ?? '' })
              }
            } catch { /* ignore */ }
          }
        } else if (block.type === 'tool_use') {
          if (textAcc) {
            await onEvent({ type: 'message', content: textAcc })
            textAcc = ''
          }
          toolCalls++
          await onEvent({
            type: 'tool_call',
            tool: block.name,
            input: block.input as Record<string, unknown>,
            callId: block.id,
          })
        }
      }

      if (textAcc) {
        await onEvent({ type: 'message', content: textAcc })
      }

      if (response.stop_reason === 'end_turn') {
        break
      }

      // If the model made tool_use calls, we'd need tool results — for now stop
      // (ClaudeSDKLoop is a baseline; full tool execution requires tool implementations)
      if (response.stop_reason === 'tool_use') {
        // Return placeholder tool results and continue
        const toolResults: Anthropic.ToolResultBlockParam[] = response.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
          .map(b => ({
            type: 'tool_result' as const,
            tool_use_id: b.id,
            content: 'Tool execution not available in SDK loop',
          }))

        for (const tr of toolResults) {
          await onEvent({
            type: 'tool_result',
            tool: '',
            callId: tr.tool_use_id,
            result: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
            isError: false,
          })
        }

        messages.push({ role: 'assistant', content: response.content })
        messages.push({ role: 'user', content: toolResults })
        continue
      }

      break
    }

    // Persist the full transcript under <workspace>/logs/ (best-effort)
    try {
      const logsDir = join(workspacePath, 'logs')
      mkdirSync(logsDir, { recursive: true })
      if (transcript.length) writeFileSync(join(logsDir, 'transcript.log'), transcript.join('\n'), 'utf8')
    } catch { /* never fail a task over logging */ }

    // Parse the last TAGS: [...] declaration from the transcript
    let tags: string[] = []
    const tagsMatch = transcript.join('\n').match(/^TAGS:\s*(\[.+\])\s*$/gm)
    if (tagsMatch) {
      try {
        const arr = JSON.parse(tagsMatch[tagsMatch.length - 1].replace(/^TAGS:\s*/, ''))
        if (Array.isArray(arr)) tags = arr.map(String).map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 3)
      } catch {}
    }

    return {
      result:      lastText.slice(0, 1000),
      tokensUsed,
      toolCalls,
      sessionId:   null,
      sessionPath: null,
      artifacts,
      tags,
    }
  }
}

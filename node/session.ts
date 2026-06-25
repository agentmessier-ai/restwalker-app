import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { CLAUDE_PROJECTS_DIR } from './db.js'

export interface SessionAnalysis {
  sessionId:    string
  sessionPath:  string
  toolCalls:    number
  tokensUsed:   number
  filesWritten: string[]
  filesEdited:  string[]
  userRequest:  string
  keySteps:     string[]
  outcome:      string
}

export function findSessionJsonl(cwd: string, startedAfter: number): string | null {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const projectDir = join(CLAUDE_PROJECTS_DIR, encoded)
  if (!existsSync(projectDir)) return null

  const files = readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
    .filter(f => f.mtime >= startedAfter)
    .sort((a, b) => b.mtime - a.mtime)

  return files[0] ? join(projectDir, files[0].name) : null
}

export function analyzeSession(sessionPath: string): SessionAnalysis {
  const lines = readFileSync(sessionPath, 'utf8').split('\n').filter(Boolean)

  let userRequest = ''
  let toolCalls = 0
  let tokensUsed = 0
  const filesWritten: string[] = []
  const filesEdited: string[] = []
  const keySteps: string[] = []
  const sessionId = basename(sessionPath, '.jsonl')
  let lastAssistantText = ''

  for (const line of lines) {
    let d: Record<string, unknown>
    try { d = JSON.parse(line) } catch { continue }

    const type = d.type as string

    if (type === 'user' && !userRequest) {
      const content = (d as { message?: { content?: unknown } }).message?.content
      if (typeof content === 'string') {
        userRequest = content.slice(0, 300)
      } else if (Array.isArray(content)) {
        userRequest = content
          .filter((c): c is { type: string; text: string } =>
            typeof c === 'object' && c !== null && (c as { type?: string }).type === 'text')
          .map(c => c.text)
          .join(' ')
          .slice(0, 300)
      }
    }

    if (type === 'assistant') {
      const msg = (d as { message?: { content?: unknown; usage?: { output_tokens?: number; input_tokens?: number } } }).message ?? {}
      const usage = (msg as { usage?: { output_tokens?: number; input_tokens?: number } }).usage ?? {}
      tokensUsed += (usage.output_tokens ?? 0) + (usage.input_tokens ?? 0)

      const content = (msg as { content?: unknown }).content
      if (Array.isArray(content)) {
        for (const c of content as Array<Record<string, unknown>>) {
          if (c.type === 'text' && typeof c.text === 'string') {
            lastAssistantText = c.text as string
          }
          if (c.type === 'tool_use') {
            toolCalls++
            const name = c.name as string
            const input = c.input as Record<string, unknown>

            if (name === 'Write') {
              const fp = (input.file_path as string | undefined) ?? ''
              filesWritten.push(fp.replace(homedir(), '~'))
              keySteps.push(`Write ${basename(fp)}`)
            } else if (name === 'Edit') {
              const fp = (input.file_path as string | undefined) ?? ''
              if (!filesEdited.includes(fp)) {
                filesEdited.push(fp.replace(homedir(), '~'))
                keySteps.push(`Edit ${basename(fp)}`)
              }
            } else if (name === 'Bash') {
              const cmd = ((input.command as string | undefined) ?? '').slice(0, 80)
              if (cmd) keySteps.push(`Bash: ${cmd}`)
            } else if (['WebSearch', 'WebFetch'].includes(name)) {
              keySteps.push(name)
            }
          }
        }
      }
    }
  }

  const seen = new Set<string>()
  const deduped = keySteps.filter(s => {
    const key = s.slice(0, 40)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 10)

  return {
    sessionId, sessionPath,
    toolCalls, tokensUsed,
    filesWritten: [...new Set(filesWritten)],
    filesEdited:  [...new Set(filesEdited)],
    userRequest:  userRequest.trim(),
    keySteps:     deduped,
    outcome:      lastAssistantText.slice(0, 400).trim(),
  }
}

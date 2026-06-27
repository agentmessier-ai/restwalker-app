import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { CLAUDE_PROJECTS_DIR } from './db.js'
import { parseTranscriptLine } from './transcript.js'

export interface ArtifactDeclaration {
  path:        string
  description: string
}

const ARTIFACT_RE = /^ARTIFACT:\s*(\{.+\})\s*$/m
const TAGS_RE     = /^TAGS:\s*(\[.+\])\s*$/m

// Append any ARTIFACT: {json} declarations found in one assistant text block.
function collectArtifacts(text: string, out: ArtifactDeclaration[]): void {
  const re = new RegExp(ARTIFACT_RE.source, 'gm')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    try {
      const decl = JSON.parse(m[1]) as { path?: string; description?: string }
      if (decl.path) out.push({ path: decl.path, description: decl.description ?? '' })
    } catch { /* malformed declaration */ }
  }
}

// The last valid TAGS: [...] declaration in a text block, normalized; null if none.
function extractTags(text: string): string[] | null {
  const matches = text.match(new RegExp(TAGS_RE.source, 'gm'))
  if (!matches) return null
  try {
    const arr = JSON.parse(matches[matches.length - 1].replace(/^TAGS:\s*/, ''))
    if (Array.isArray(arr)) return arr.map(String).map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 3)
  } catch { /* malformed */ }
  return null
}

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
  artifacts:    ArtifactDeclaration[]
  tags:         string[]
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
  const artifacts: ArtifactDeclaration[] = []
  let tags: string[] = []
  const sessionId = basename(sessionPath, '.jsonl')
  let lastAssistantText = ''

  for (const line of lines) {
    const e = parseTranscriptLine(line)
    if (!e) continue

    if (e.type === 'user' && !userRequest) userRequest = e.textBlocks.join(' ').slice(0, 300)
    if (e.type !== 'assistant') continue

    tokensUsed += e.usage.output_tokens + e.usage.input_tokens
    for (const text of e.textBlocks) {
      lastAssistantText = text
      collectArtifacts(text, artifacts)
      const t = extractTags(text)
      if (t) tags = t                              // a later turn overrides an earlier one
    }
    for (const u of e.toolUses) {
      toolCalls++
      const input = u.input as Record<string, unknown>
      if (u.name === 'Write') {
        const fp = (input.file_path as string | undefined) ?? ''
        filesWritten.push(fp.replace(homedir(), '~'))
        keySteps.push(`Write ${basename(fp)}`)
      } else if (u.name === 'Edit') {
        const fp = (input.file_path as string | undefined) ?? ''
        if (!filesEdited.includes(fp)) {
          filesEdited.push(fp.replace(homedir(), '~'))
          keySteps.push(`Edit ${basename(fp)}`)
        }
      } else if (u.name === 'Bash') {
        const cmd = ((input.command as string | undefined) ?? '').slice(0, 80)
        if (cmd) keySteps.push(`Bash: ${cmd}`)
      } else if (['WebSearch', 'WebFetch'].includes(u.name)) {
        keySteps.push(u.name)
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
    artifacts,
    tags,
  }
}

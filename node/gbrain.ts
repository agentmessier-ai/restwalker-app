// Optional GBrain integration.
// If GBRAIN_URL is not set, all functions are no-ops.
// GBRAIN_URL example: http://localhost:3141

const GBRAIN_URL = process.env.GBRAIN_URL ?? ''
const GBRAIN_KEY = process.env.GBRAIN_API_KEY ?? ''

let _log = { info: console.log, warn: console.warn }
export function setLogger(l: typeof _log) { _log = l }

async function gbrainPost(path: string, body: unknown): Promise<unknown> {
  if (!GBRAIN_URL) return null
  try {
    const res = await fetch(`${GBRAIN_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(GBRAIN_KEY ? { Authorization: `Bearer ${GBRAIN_KEY}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      _log.warn(`[gbrain] ${path} HTTP ${res.status}`)
      return null
    }
    return res.json()
  } catch (e) {
    _log.warn(`[gbrain] ${path} error: ${(e as Error).message}`)
    return null
  }
}

/** Search GBrain for context relevant to a task description. Returns a summary string or null. */
export async function enrichTaskPrompt(description: string): Promise<string | null> {
  if (!GBRAIN_URL) return null
  const result = await gbrainPost('/api/search', { query: description, mode: 'balanced' }) as any
  if (!result?.answer) return null
  _log.info(`[gbrain] enriched prompt for task: ${description.slice(0, 60)}`)
  return `\n\n---\n**Relevant context from your knowledge base:**\n${result.answer}\n---\n`
}

/** Store a completed task's result as a GBrain page for future reference. */
export async function storeTaskResult(taskId: number, description: string, result: string, workspacePath: string): Promise<void> {
  if (!GBRAIN_URL) return
  await gbrainPost('/api/pages', {
    title: `restwalker task #${taskId}: ${description.slice(0, 60)}`,
    content: `## Task\n${description}\n\n## Result\n${result}\n\n## Workspace\n${workspacePath}`,
    tags: ['restwalker', 'task-result'],
  })
  _log.info(`[gbrain] stored result for task #${taskId}`)
}

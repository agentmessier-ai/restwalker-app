import https from 'https'
import type { Plugin } from '../plugins.js'

let _log = { info: console.log, warn: console.warn }
export function setLogger(l: typeof _log) { _log = l }

// ignoreSsl is an explicit per-task opt-in for self-signed certs in internal
// environments. Users accept the MITM risk when they check the box.
async function callWebhook(
  url: string,
  payload: Record<string, unknown>,
  opts: { timeoutMs: number; retries: number; ignoreSsl: boolean }
): Promise<void> {
  const agent = opts.ignoreSsl ? new https.Agent({ rejectUnauthorized: false }) : undefined
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
        // @ts-ignore — Node fetch accepts agent
        agent,
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      _log.info(`[webhook] ${payload.event}-webhook ok → ${url}`)
      return
    } catch (e) {
      lastErr = e as Error
      if (attempt < opts.retries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
      }
    }
  }
  _log.warn(`[webhook] failed → ${url}: ${lastErr!.message}`)
}

export const webhookPlugin: Plugin = {
  name: 'webhook',
  register(ctx) {
    ctx.on('pre_task', async ({ task }) => {
      if (!task.webhook_pre_url) return
      await callWebhook(
        task.webhook_pre_url,
        { event: 'pre', task_id: task.id, description: task.description },
        { timeoutMs: task.webhook_timeout_ms ?? 10000, retries: task.webhook_retry ?? 2, ignoreSsl: (task.webhook_ignore_ssl ?? 0) === 1 }
      )
    })

    ctx.on('post_task', async ({ task, workspacePath, status, tokensUsed, toolCalls, result }) => {
      if (!task.webhook_post_url) return
      await callWebhook(
        task.webhook_post_url,
        {
          event: 'post',
          task_id: task.id,
          description: task.description,
          status,
          tokens_used: tokensUsed,
          tool_calls: toolCalls,
          workspace_path: workspacePath,
          result: result.slice(0, 500),
        },
        { timeoutMs: task.webhook_timeout_ms ?? 10000, retries: task.webhook_retry ?? 2, ignoreSsl: (task.webhook_ignore_ssl ?? 0) === 1 }
      )
    })
  },
}

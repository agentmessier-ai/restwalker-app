/**
 * Restwalker MCP server — stdio transport for Claude Code.
 *
 * Tool input schemas are derived at startup from the live OpenAPI spec
 * at /docs/json, so they stay in sync with the API automatically.
 * Descriptions are written here for Claude UX; everything else is DRY.
 *
 * Register with Claude Code:
 *   claude mcp add restwalker -- node /path/to/node_modules/.bin/tsx /path/to/node/mcp.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE = process.env.RESTWALKER_URL ?? 'http://localhost:47290'

// ── HTTP helper ────────────────────────────────────────────────────────────────

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number>,
): Promise<T> {
  const url = new URL(`${BASE}${path}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

// ── Server ─────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'restwalker', version: '1.0.0' })

// ── Status & usage ─────────────────────────────────────────────────────────────

server.tool(
  'status',
  'Get daemon status: Claude usage %, coding window, gate open/closed, thresholds',
  {},
  async () => text(await api('GET', '/status')),
)

server.tool(
  'can_run',
  'Quick check: is the usage gate open right now?',
  {},
  async () => text(await api('GET', '/can-run')),
)

server.tool(
  'usage_history',
  'Usage history bucketed into 15-minute intervals',
  { hours: z.number().int().min(1).max(720).default(48).describe('How many hours back to fetch') },
  async ({ hours }) => text(await api('GET', '/history', undefined, { hours: hours ?? 48 })),
)

server.tool(
  'sync',
  'Force a Claude usage cache refresh',
  {},
  async () => text(await api('POST', '/sync')),
)

// ── Queue ──────────────────────────────────────────────────────────────────────

server.tool(
  'queue_stats',
  'Task counts by status (scheduled / pending / running / done / failed / total)',
  {},
  async () => text(await api('GET', '/queue/stats')),
)

server.tool(
  'queue_list',
  'List tasks with pagination, newest first',
  {
    limit:  z.number().int().min(1).max(100).default(25).optional().describe('Page size (max 100)'),
    offset: z.number().int().min(0).default(0).optional().describe('Pagination offset'),
  },
  async ({ limit, offset }) =>
    text(await api('GET', '/queue', undefined, { limit: limit ?? 25, offset: offset ?? 0 })),
)

server.tool(
  'queue_get',
  'Get a single task by ID',
  { id: z.number().int().describe('Task ID') },
  async ({ id }) => text(await api('GET', `/queue/${id}`)),
)

server.tool(
  'queue_add',
  'Enqueue a new background task for execution by Claude Code when the gate opens',
  {
    description: z.string().describe('The task prompt sent to the agent'),
    cwd:         z.string().optional().describe('Working directory for the agent'),
    model:       z.string().optional().describe('Model ID, e.g. claude-sonnet-4-6'),
    provider_id: z.number().int().optional().describe('Provider ID (omit for default)'),
    schedule:    z.enum(['once','hourly','daily','weekly','monthly']).default('once').optional()
                   .describe('Recurrence — once runs immediately, others repeat'),
  },
  async (args) => text(await api('POST', '/queue', args)),
)

server.tool(
  'queue_cancel',
  'Cancel a pending or scheduled task',
  { id: z.number().int().describe('Task ID') },
  async ({ id }) => text(await api('DELETE', `/queue/${id}`)),
)

server.tool(
  'queue_force_run',
  'Force-run a pending task immediately, bypassing the usage gate',
  { id: z.number().int().describe('Task ID') },
  async ({ id }) => text(await api('POST', `/queue/${id}/force-run`)),
)

server.tool(
  'queue_session',
  'Get the parsed Claude Code session transcript for a completed task (thinking blocks, tool calls, results)',
  { id: z.number().int().describe('Task ID') },
  async ({ id }) => text(await api('GET', `/queue/${id}/session`)),
)

// ── Providers ──────────────────────────────────────────────────────────────────

server.tool(
  'list_providers',
  'List configured agent providers',
  {},
  async () => text(await api('GET', '/providers')),
)

server.tool(
  'add_provider',
  'Add a new agent provider',
  {
    name:         z.string().describe('Display name'),
    command:      z.string().describe('Executable, e.g. claude or /usr/local/bin/claude'),
    args_template:z.string().optional()
                   .describe('JSON array with {{task}}, {{model}}, {{cwd}} placeholders'),
  },
  async (args) => text(await api('POST', '/providers', args)),
)

server.tool(
  'set_default_provider',
  'Set the default agent provider',
  { id: z.number().int().describe('Provider ID') },
  async ({ id }) => text(await api('POST', `/providers/${id}/default`)),
)

// ── Discovery ──────────────────────────────────────────────────────────────────

server.tool(
  'list_models',
  'List available Anthropic models from the live API',
  {},
  async () => text(await api('GET', '/models')),
)

server.tool(
  'list_projects',
  'List Claude Code projects from ~/.claude/history.jsonl, sorted by recency — use as cwd suggestions',
  {},
  async () => text(await api('GET', '/projects')),
)

// ── Settings ───────────────────────────────────────────────────────────────────

server.tool(
  'get_settings',
  'Get all daemon settings (thresholds, timezone, poll intervals)',
  {},
  async () => text(await api('GET', '/settings')),
)

server.tool(
  'update_settings',
  'Update one or more daemon settings',
  {
    CODING_WINDOW_ENABLED: z.enum(['0','1']).optional().describe('Enable coding window time gate (1=on, 0=off)'),
    CODING_START_H:       z.string().optional().describe('Hour (0-23) coding window starts'),
    CODING_END_H:         z.string().optional().describe('Hour (0-23) coding window ends'),
    TIMEZONE:             z.string().optional().describe('IANA timezone, e.g. America/Los_Angeles'),
    FIVE_HOUR_PAUSE_PCT:  z.string().optional().describe('5-hour usage % that pauses the gate'),
    WEEKLY_RESERVE_PCT:   z.string().optional().describe('Weekly usage % below which gate is always open'),
    WEEKLY_HARD_STOP_PCT: z.string().optional().describe('Weekly usage % that hard-stops the gate'),
    POLL_INTERVAL_MIN:    z.string().optional().describe('Usage poll interval in minutes'),
    CACHE_STALE_MIN:      z.string().optional().describe('Cache stale threshold in minutes'),
  },
  async (args) => {
    const updates = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))
    return text(await api('POST', '/settings', updates))
  },
)

// ── Artifacts ─────────────────────────────────────────────────────────────────

server.tool(
  'queue_artifacts',
  'List artifacts declared by a completed task (files the agent created and tagged for review)',
  { task_id: z.number().describe('Task ID') },
  async ({ task_id }) => text(await api('GET', `/queue/${task_id}/artifacts`)),
)

// ── System prompt ─────────────────────────────────────────────────────────────

server.tool(
  'system_prompt_get',
  'Get the active system prompt injected into every task',
  {},
  async () => text(await api('GET', '/system-prompt')),
)

server.tool(
  'system_prompt_set',
  'Save a new version of the system prompt (becomes active immediately)',
  { content: z.string().describe('New system prompt content'), label: z.string().optional().describe('Version label') },
  async ({ content, label }) => text(await api('POST', '/system-prompt', { content, label })),
)

// ── Task prompts ──────────────────────────────────────────────────────────────

server.tool(
  'task_prompt_save',
  'Save a new version of a task prompt and optionally queue a run. Pass origin_id to add a version to an existing chain; omit to create a new prompt.',
  {
    content:     z.string().describe('Prompt content'),
    title:       z.string().optional().describe('Version label'),
    schedule:    z.enum(['once','hourly','daily','weekly','monthly']).optional().default('once'),
    cwd:         z.string().optional().describe('Working directory override'),
    model:       z.string().optional(),
    provider_id: z.number().optional(),
    origin_id:   z.number().optional().describe('Existing prompt chain ID — omit to create new'),
    run_now:     z.boolean().optional().describe('Queue a task run immediately'),
  },
  async ({ content, title, schedule, cwd, model, provider_id, origin_id, run_now }) => {
    if (origin_id) {
      return text(await api('POST', `/task-prompts/${origin_id}/versions`, { content, title, schedule, cwd, model, provider_id, run_now }))
    }
    return text(await api('POST', '/task-prompts', { content, title, schedule, cwd, model, provider_id, run_now }))
  },
)

server.tool(
  'task_prompt_versions',
  'List all versions of a task prompt chain',
  { prompt_id: z.number().describe('Any prompt ID in the chain') },
  async ({ prompt_id }) => text(await api('GET', `/task-prompts/${prompt_id}/versions`)),
)

// ── Connect ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)

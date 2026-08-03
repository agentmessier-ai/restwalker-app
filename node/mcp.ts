/**
 * Restwalker MCP server — stdio transport for Claude Code.
 *
 * API-first: every tool's input schema is derived from the app's own OpenAPI
 * spec (querystring, path params, and request body alike). The spec is built
 * in-process via `buildApp()` — no HTTP fetch, no dependency on the daemon
 * being up. Add/change a field on a Fastify route and the MCP tool's schema
 * follows automatically; nothing is duplicated by hand except each tool's
 * `name`, its agent-facing `description`, and (rarely) a field-description
 * override or the small set of listed exceptions below.
 *
 * Actually *calling* a tool still talks HTTP to the running daemon at
 * RESTWALKER_URL — that part still needs the daemon up, and fails per-call
 * with a clear error if it isn't, rather than preventing every tool from
 * registering.
 *
 * Register with Claude Code:
 *   claude mcp add restwalker -- node /path/to/node_modules/.bin/tsx /path/to/node/mcp.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { buildApp } from './app.js'

const BASE = process.env.RESTWALKER_URL ?? 'http://localhost:47290'

// ── HTTP helper (actual tool calls — needs the daemon running) ────────────────

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

// ── OpenAPI → Zod schema derivation ───────────────────────────────────────────

interface OApiProperty {
  type?: string | string[]
  enum?: string[]
  description?: string
  minimum?: number
  maximum?: number
}

interface OApiBodySchema {
  properties?: Record<string, OApiProperty>
  required?: string[]
}

interface OApiParam {
  name: string
  in: 'query' | 'path'
  required?: boolean
  schema?: OApiProperty
  description?: string
}

interface OApiOperation {
  parameters?: OApiParam[]
  requestBody?: { content?: { 'application/json'?: { schema?: OApiBodySchema } } }
}

export interface OApiSpec {
  paths: Record<string, Record<string, OApiOperation>>
}

// Convert a single OpenAPI property to a Zod type
function propToZod(prop: OApiProperty): z.ZodTypeAny {
  const types = Array.isArray(prop.type) ? prop.type : [prop.type ?? 'string']
  const nullable = types.includes('null')
  const base = types.find(t => t !== 'null') ?? 'string'

  let schema: z.ZodTypeAny

  if (prop.enum) {
    const vals = prop.enum as [string, ...string[]]
    schema = z.enum(vals)
  } else if (base === 'integer' || base === 'number') {
    let n = z.number()
    if (prop.minimum !== undefined) n = n.min(prop.minimum)
    if (prop.maximum !== undefined) n = n.max(prop.maximum)
    schema = n
  } else if (base === 'boolean') {
    schema = z.boolean()
  } else {
    schema = z.string()
  }

  if (nullable) schema = schema.nullable()
  if (prop.description) schema = schema.describe(prop.description)
  return schema
}

// Build a Zod object shape from an OpenAPI request-body schema, with optional
// field-description overrides (for tools where the spec's own wording is bare).
function buildZodShape(
  schema: OApiBodySchema,
  descriptionOverrides: Record<string, string> = {},
): Record<string, z.ZodTypeAny> {
  const required = new Set(schema.required ?? [])
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const override = descriptionOverrides[key]
    const merged = override ? { ...prop, description: override } : prop
    let field = propToZod(merged)
    if (!required.has(key)) field = field.optional()
    shape[key] = field
  }
  return shape
}

// Where a field's value has to go when actually calling the route.
export interface FieldLoc { name: string; loc: 'query' | 'path' | 'body' }

// Pull every input a route accepts — querystring, path params, and JSON body —
// out of the spec for one operation, as a single flat Zod shape plus a map of
// where each field belongs on the wire (query/path/body split back out at call time).
export function operationFields(
  spec: OApiSpec,
  method: string,
  path: string,
  descriptionOverrides: Record<string, string> = {},
  bool01: string[] = [],
): { shape: Record<string, z.ZodTypeAny>; locs: FieldLoc[] } {
  const op = spec.paths[path]?.[method.toLowerCase()]
  if (!op) throw new Error(`no such operation in the OpenAPI spec: ${method} ${path}`)

  const shape: Record<string, z.ZodTypeAny> = {}
  const locs: FieldLoc[] = []

  for (const p of op.parameters ?? []) {
    const override = descriptionOverrides[p.name]
    const desc = override ?? p.description
    // A field that's boolean on the tool but '0'/'1' on the wire (see registerManifestTool):
    // build z.boolean() straight from the spec description text — NOT by reading
    // `.description` off the already-built zod field, because in zod v4 wrapping
    // a schema in `.optional()` produces a new object whose OWN `.description` is
    // undefined (it doesn't delegate to the inner type), so that introspection
    // silently loses the description once optional() has already run.
    let field = bool01.includes(p.name)
      ? (desc ? z.boolean().describe(desc) : z.boolean())
      : propToZod({ ...(p.schema ?? {}), description: desc })
    if (!p.required) field = field.optional()
    shape[p.name] = field
    locs.push({ name: p.name, loc: p.in })
  }

  const bodySchema = op.requestBody?.content?.['application/json']?.schema
  if (bodySchema) {
    for (const [k, v] of Object.entries(buildZodShape(bodySchema, descriptionOverrides))) {
      shape[k] = v
      locs.push({ name: k, loc: 'body' })
    }
  }

  return { shape, locs }
}

// ── Server ─────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'restwalker', version: '1.0.0' })

// A tool whose schema and call-wiring are fully derived from the spec — this
// covers every tool except the handful with cross-endpoint routing logic
// (task_prompt_save) or a schema too generic to derive usefully (update_settings).
export interface ToolDef {
  name:        string
  method:      'GET' | 'POST' | 'PUT' | 'DELETE'
  path:        string                      // spec path, e.g. '/queue/{id}/session'
  description: string                      // agent-facing — the spec has no equivalent
  describe?:   Record<string, string>      // per-field description overrides
  omit?:       string[]                    // spec fields to hide from the tool
  bool01?:     string[]                    // fields that are boolean on the tool but '0'/'1' on the wire
}

// Pure: turn a tool call's args into a concrete request (path with {params}
// substituted, querystring, JSON body) — no fetch, so it's testable without a
// running daemon.
export function buildRequest(
  def: ToolDef,
  locs: FieldLoc[],
  args: Record<string, unknown>,
): { path: string; query?: Record<string, string>; body?: Record<string, unknown> } {
  let urlPath = def.path
  const query: Record<string, string> = {}
  const body: Record<string, unknown> = {}

  for (const loc of locs) {
    if (def.omit?.includes(loc.name)) continue
    const val = args[loc.name]
    if (val === undefined) continue

    if (loc.loc === 'path') {
      urlPath = urlPath.replace(`{${loc.name}}`, String(val))
    } else if (loc.loc === 'query') {
      if (def.bool01?.includes(loc.name)) { if (val) query[loc.name] = '1' }
      else query[loc.name] = String(val)
    } else {
      body[loc.name] = val
    }
  }

  return {
    path: urlPath,
    query: Object.keys(query).length ? query : undefined,
    body: Object.keys(body).length ? body : undefined,
  }
}

function registerManifestTool(spec: OApiSpec, def: ToolDef) {
  const { shape, locs } = operationFields(spec, def.method, def.path, def.describe, def.bool01)

  for (const key of def.omit ?? []) delete shape[key]

  server.tool(def.name, def.description, shape, async (args: Record<string, unknown>) => {
    const req = buildRequest(def, locs, args)
    return text(await api(def.method, req.path, req.body, req.query))
  })
}

export const TOOLS: ToolDef[] = [
  // ── Status & usage ───────────────────────────────────────────────────────────
  { name: 'status', method: 'GET', path: '/status',
    description: 'Get daemon status: Claude usage %, coding window, gate open/closed, thresholds' },
  { name: 'can_run', method: 'GET', path: '/can-run',
    description: 'Quick check: is the usage gate open right now?',
    describe: { project: "Project identifier (default 'default')" } },
  { name: 'usage_history', method: 'GET', path: '/history',
    description: 'Usage history bucketed into 15-minute intervals',
    describe: { hours: 'How many hours back to fetch (default 48)' } },
  { name: 'sync', method: 'POST', path: '/sync',
    description: 'Force a Claude usage cache refresh' },

  // ── Queue ────────────────────────────────────────────────────────────────────
  { name: 'queue_add', method: 'POST', path: '/queue',
    description: 'Enqueue a new background task for execution by Claude Code when the gate opens',
    describe: {
      description:      'The task prompt sent to the agent',
      cwd:               'Working directory for the agent',
      model:              'Model ID, e.g. claude-sonnet-4-6',
      provider_id:        'Provider ID (omit for default)',
      schedule:           'Recurrence — once runs immediately, others repeat',
      webhook_pre_url:    'URL to POST before the agent starts',
      webhook_post_url:   'URL to POST after the agent finishes (includes status, tokens, result)',
      webhook_timeout_s:  'Webhook HTTP timeout in seconds (default 10)',
      webhook_retry:      'Webhook retry attempts on failure (default 2)',
      webhook_ignore_ssl: 'Set 1 to skip TLS verification for self-signed certs',
      timeout_s:          'Per-task agent timeout in seconds (default 600 = 10 min)',
    } },
  { name: 'queue_stats', method: 'GET', path: '/queue/stats',
    description: 'Task counts by status (scheduled / pending / running / done / failed / total)' },
  { name: 'queue_list', method: 'GET', path: '/queue',
    description: 'List tasks with pagination and filtering, newest first',
    describe: {
      limit:  'Page size (max 100, default 25)',
      offset: 'Pagination offset',
      status: 'Filter to a single task status',
      schedule_type: 'Filter to once-off or recurring tasks',
      sort:   'Sort by created/finished/duration',
      dir:    'Sort direction',
      tag:    'Filter to tasks carrying this tag',
    } },
  { name: 'queue_get', method: 'GET', path: '/queue/{id}',
    description: 'Get a single task by ID', describe: { id: 'Task ID' } },
  { name: 'queue_cancel', method: 'DELETE', path: '/queue/{id}',
    description: 'Cancel a pending or scheduled task', describe: { id: 'Task ID' } },
  { name: 'queue_force_run', method: 'POST', path: '/queue/{id}/force-run',
    description: 'Force-run a pending task immediately, bypassing the usage gate', describe: { id: 'Task ID' } },
  { name: 'queue_session', method: 'GET', path: '/queue/{id}/session',
    description: 'Get the parsed Claude Code session transcript for a completed task (thinking blocks, tool calls, results)',
    describe: { id: 'Task ID' } },
  { name: 'queue_artifacts', method: 'GET', path: '/queue/{id}/artifacts',
    description: 'List artifacts declared by a completed task (files the agent created and tagged for review)',
    describe: { id: 'Task ID' } },

  // ── Providers ────────────────────────────────────────────────────────────────
  { name: 'list_providers', method: 'GET', path: '/providers',
    description: 'List configured agent providers' },
  { name: 'add_provider', method: 'POST', path: '/providers',
    description: 'Add a new agent provider',
    describe: {
      name:          'Display name',
      command:       'Executable, e.g. claude or /usr/local/bin/claude',
      args_template: 'JSON array with {{task}}, {{model}}, {{cwd}} placeholders',
      loop_type:     'claude_print = spawn the CLI (the pipe); claude_sdk = Anthropic Messages API',
    } },
  { name: 'set_default_provider', method: 'POST', path: '/providers/{id}/default',
    description: 'Set the default agent provider', describe: { id: 'Provider ID' } },

  // ── Discovery ────────────────────────────────────────────────────────────────
  { name: 'list_models', method: 'GET', path: '/models',
    description: 'List available Anthropic models from the live API' },
  { name: 'list_projects', method: 'GET', path: '/projects',
    description: 'List Claude Code projects from ~/.claude/history.jsonl, sorted by recency — use as cwd suggestions' },

  // ── Teleport ─────────────────────────────────────────────────────────────────
  // Deliberately NOT exposed as MCP tools. The `/teleport/*` HTTP routes stay —
  // the dashboard and any direct API caller still use them — but the chat-facing
  // surface now belongs to the standalone `teleport` project (tp/tpd), which
  // owns per-device pairing and an encrypted peer channel. Two competing
  // cross-session tools in one Claude session is worse than one.

  // ── Settings ─────────────────────────────────────────────────────────────────
  { name: 'get_settings', method: 'GET', path: '/settings',
    description: 'Get all daemon settings (thresholds, timezone, poll intervals)' },

  // ── Artifacts ────────────────────────────────────────────────────────────────
  // (queue_artifacts is under Queue above, since it's keyed off a task id)

  // ── System prompt ────────────────────────────────────────────────────────────
  { name: 'system_prompt_get', method: 'GET', path: '/system-prompt',
    description: 'Get the active system prompt injected into every task' },
  { name: 'system_prompt_set', method: 'POST', path: '/system-prompt',
    description: 'Save a new version of the system prompt (becomes active immediately)',
    describe: { content: 'New system prompt content', label: 'Version label' } },

  // ── Task prompts ─────────────────────────────────────────────────────────────
  { name: 'task_prompt_versions', method: 'GET', path: '/task-prompts/{id}/versions',
    description: 'List all versions of a task prompt chain', describe: { id: 'Any prompt ID in the chain' } },
]

// task_prompt_save routes to one of two endpoints depending on origin_id, so it
// can't be expressed as a single (method, path) — but its Zod shape is still
// pulled from the spec (POST /task-prompts and POST /task-prompts/{id}/versions
// share the same body shape).
function registerTaskPromptSave(spec: OApiSpec) {
  const { shape } = operationFields(spec, 'POST', '/task-prompts', {
    content:   'Prompt content',
    title:     'Version label',
    schedule:  'Recurrence schedule',
    cwd:       'Working directory override',
    run_now:   'Queue a task run immediately',
  })
  shape.origin_id = z.number().optional().describe('Existing prompt chain ID — omit to create new')

  server.tool(
    'task_prompt_save',
    'Save a new version of a task prompt and optionally queue a run. Pass origin_id to add a version to an existing chain; omit to create a new prompt.',
    shape,
    async ({ origin_id, ...rest }: Record<string, unknown>) => {
      if (origin_id) return text(await api('POST', `/task-prompts/${origin_id}/versions`, rest))
      return text(await api('POST', '/task-prompts', rest))
    },
  )
}

// update_settings takes a free-form settings object on the wire (POST /settings
// has no fixed property schema to derive from), so its fields stay hand-written.
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
    DREAM_JOURNAL_USE_AGENT_REACH: z.enum(['0','1']).optional().describe('Use agent-reach (Exa/Reddit/Twitter/GitHub) for Dream Journal\'s trending scan (1=on, 0=off, default off)'),
  },
  async (args) => {
    const updates = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))
    return text(await api('POST', '/settings', updates))
  },
)

// ── Connect ────────────────────────────────────────────────────────────────────

// Only actually run the server (build the spec, register the derived tools,
// connect stdio) when this file is the entry point — not when a test imports
// it for TOOLS/operationFields/buildRequest, which are pure and need none of this.
if (import.meta.url === `file://${process.argv[1]}`) {
  // Build the app in-process purely to read its OpenAPI spec — never listens,
  // so this works even if the real daemon isn't running.
  const specApp = await buildApp()
  await specApp.ready()
  const spec = specApp.swagger() as unknown as OApiSpec

  for (const def of TOOLS) registerManifestTool(spec, def)
  registerTaskPromptSave(spec)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

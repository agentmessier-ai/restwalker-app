# MCP tool derivation — design

> `mcp.ts` says it derives tool schemas from the API. It does that for 2 of 28 tools.
> The other 26 are hand-written Zod that has already drifted from the routes it mirrors.

## Problem

The file header of `node/mcp.ts` states the intent plainly:

```
 * API-first: tool input schemas for POST endpoints are derived at startup
 * from the live OpenAPI spec at /docs/json. Add a field to a Fastify route
 * and it automatically appears in the MCP tool — no manual Zod duplication.
```

That is true of `queue_add` and `task_prompt_save`. It is false of the other 26 tools, which
carry **48 hand-written Zod field declarations** across 17 tools. The header describes an
aspiration as if it were the architecture.

### 1. Derivation only ever handled request *bodies*

`fetchBodySchema` (`node/mcp.ts:90-93`) reaches exactly one place in the spec:

```ts
return spec.paths[path]?.[method]?.requestBody?.content?.['application/json']?.schema ?? {}
```

`requestBody` exists only for POST/PUT. Every GET tool — the majority — has its inputs in
`parameters` (`in: query` / `in: path`), which this function never looks at. So the derivation
path is structurally unavailable to most of the API, and hand-writing isn't a shortcut anyone
took: it's the only option the helper leaves.

The spec itself is not the limitation. `/docs/json` already publishes everything needed —
verified against the live daemon:

```jsonc
// GET /teleport/list → parameters
[ { "in": "query", "name": "folder", "required": true,  "schema": {"type":"string"},
    "description": "Folder name, path, or substring" },
  { "in": "query", "name": "window", "required": false, "schema": {"type":"string"},
    "description": "e.g. 1h, 6h, 24h (default from settings)" } ]
// GET /providers/{id} → parameters
[ { "in": "path", "name": "id", "required": true, "schema": {"type":"integer"} } ]
```

Name, location, requiredness, type, enum, and description are all present. `buildZodShape`
could consume them unchanged; nothing reads them.

### 2. The hand-written copies have already drifted

This is not hypothetical. Comparing each tool's Zod block against its route's spec entry on the
running daemon:

| Tool | Route | Exposed by the tool | Supported by the API but **missing from the tool** |
|---|---|---|---|
| `queue_list` | `GET /queue` | `limit`, `offset` | `status`, `schedule_type`, `sort`, `dir`, `tag` |
| `can_run` | `GET /can-run` | — | `project` |

`queue_list` is the costly one. The route supports filtering by task status
(`pending`/`running`/`scheduled`/`done`/`failed`/`cancelled`), by schedule type, by tag, and
sorting by created/finished/duration. An agent using the MCP tool can do none of that — it can
only page blindly through everything, newest first. The capability exists, is documented in the
spec, and is invisible at the only surface an agent can reach.

Nothing detects this. There is no test that compares a tool's schema to its route, so drift is
silent and permanent by default.

### 3. Every new route repeats the work

Adding `/teleport/search` (this week) meant writing the querystring schema in
`routes/teleport.ts`, then writing the same six fields again as Zod in `mcp.ts`, with the
descriptions retyped. The second copy is the one that can rot. The same applies to the `before`
param added to `/teleport/conversation` — declared twice, by hand, in two files.

### 4. Coverage is decided by whoever remembered to add a tool

Of 48 operations in the spec, roughly 20 have no MCP tool. Many of those are correct omissions
(`/healthz`, `/teleport/ping`, `OPTIONS`, the static UI routes). Several are not:

- `GET /queue/tags` — no way for an agent to discover what tags exist
- `GET /queue/origin/{id}/runs` — run history for a recurring task
- `GET /artifacts/{id}/content` — `queue_artifacts` lists artifacts but nothing can read one
- `PUT /providers/{id}`, `DELETE /providers/{id}` — providers can be added, never edited or removed

Because exposure is a manual act, the boundary between "deliberately internal" and "nobody got
to it" isn't recorded anywhere.

### 5. Daemon down at boot = zero tools, not two

`registerDerivedTools()` is awaited at the top level (`mcp.ts:431`) with no error handling.
Verified failure mode:

```
$ RESTWALKER_URL=http://localhost:59999 npx tsx mcp.ts
TypeError: fetch failed
    at async api (node/mcp.ts:30:15)
    at async fetchBodySchema (node/mcp.ts:91:16)
    at async registerDerivedTools (node/mcp.ts:121:23)
    at async <anonymous> (node/mcp.ts:431:1)
  [cause]: AggregateError [ECONNREFUSED]
```

The process dies before `server.connect(transport)`. If the daemon isn't up when Claude Code
launches the MCP server — a plain cold-start ordering race — **all 28 tools disappear**, not
just the 2 that needed the spec. Expanding derivation without fixing this widens an already
total blast radius.

(Minor, same area: `fetchBodySchema` re-fetches `/docs/json` per call — twice today, once per
derived tool. With every tool derived that becomes 28 fetches of the same document.)

## Goals

- **One declaration per field.** A route's querystring/body schema is the single source; the MCP
  tool's input schema is derived from it, never retyped.
- **Drift becomes impossible, not merely discouraged** — there is no second copy to fall out of
  sync.
- **New routes are exposed by naming them**, not by re-describing them.
- **The MCP server always starts**, with its full tool set, regardless of daemon state. Failures
  belong at call time, per tool, with a clear message.
- Keep tool names and agent-facing descriptions **hand-written** — see the next section for why.

## Non-goals

- Not auto-exposing every route as a tool. Coverage stays a deliberate, reviewed decision; this
  only removes the *schema* duplication, not the editorial one.
- No change to the REST API's wire format. Existing `curl` callers (including the teleport
  skill's documented commands) keep working exactly as they do.
- Not a new dependency or code generator. No build step emitting `.ts` files.

## What the spec can and cannot supply

Worth stating precisely, because it bounds the design:

| Needed to register a tool | In the spec? |
|---|---|
| Field names, types, enums, required, min/max | **Yes** — `parameters[]` and `requestBody` |
| Field descriptions | **Yes** — already written in the route schemas |
| HTTP method + path | Yes, as the map key |
| **Tool name** | **No** — Fastify emits no `operationId` (verified: 0 of 48 operations have one) |
| **Agent-facing tool description** | **No** — `summary` is written for humans reading `/docs`, and the good MCP descriptions (`teleport_search`'s "check `sessions_scanned` before concluding…") are guidance a REST summary should not carry |

So full auto-generation is off the table, and that's fine — the duplication that hurts is the
*schema*, not the name. The design keeps a hand-written binding of `tool name → method + path +
description`, and derives everything below it.

## Design

### A. A tool manifest replaces 26 `server.tool()` blocks

```ts
interface ToolDef {
  name:        string
  method:      'GET' | 'POST' | 'PUT' | 'DELETE'
  path:        string                        // spec path, e.g. '/queue/{id}/session'
  description: string                        // agent-facing; the part worth hand-writing
  describe?:   Record<string, string>        // per-field description overrides
  omit?:       string[]                      // spec fields to hide from the tool
  bool01?:     string[]                      // see "0/1 impedance" below
}

const TOOLS: ToolDef[] = [
  { name: 'queue_list', method: 'GET', path: '/queue',
    description: 'List tasks with pagination and filtering, newest first' },
  { name: 'queue_session', method: 'GET', path: '/queue/{id}/session',
    description: 'Get the parsed Claude Code session transcript for a completed task' },
  { name: 'teleport', method: 'GET', path: '/teleport/conversation',
    description: 'Pull the RAW recent Claude Code conversation …',
    bool01: ['full'] },
  // …
]
```

`queue_list` gains `status` / `tag` / `sort` / `dir` / `schedule_type` by deletion — the drift in
§2 closes as a side effect of not hand-writing the schema.

### B. One generic registrar and one generic handler

```
for each ToolDef:
  fields = spec.paths[path][method].parameters        → split by `in`: query | path
         + spec.paths[path][method].requestBody       → body fields
  shape  = buildZodShape(fields, def.describe)        (already exists, extended for parameters)
  server.tool(def.name, def.description, shape, async args => {
    url  = def.path with {param} substituted from path-args
    send query-args as querystring, body-args as JSON body
  })
```

The three input locations (`path`, `query`, `body`) are flattened into one Zod object for the
agent and re-split by the handler using the `in` field the spec already gives us. That removes
the last hand-written thing in every current handler — the manual
`{ folder, ...(window ? { window } : {}) }` assembly, repeated 17 times and easy to get wrong.

### C. `0`/`1` impedance

Two params take `enum: ['0','1']` as a string on the wire (`full` on `/teleport/conversation`
and `/teleport/handoff`). Derived literally, the agent would see a string enum instead of a
boolean — a worse tool surface.

Handled with the `bool01` marker in the manifest: the Zod field is declared `z.boolean()`, and
the generic handler serializes `true → '1'`, `false`/absent → omitted. The wire format is
untouched, so nothing existing breaks.

*Rejected:* changing the route schemas to `type: 'boolean'` and letting Fastify coerce. Cleaner
in principle, but Fastify/ajv coerces `"true"`/`"false"`, not `"1"`/`"0"` — it would break every
existing `?full=1` caller, including the documented teleport `curl` commands. Not worth it for
two fields.

### D. The spec source: in-process, not over HTTP

The startup fragility in §5 is really a symptom of fetching the spec over the network from the
very service the MCP server is a client of. `@fastify/swagger` can produce the document without
any of that: `app.swagger()` returns it from a built-but-never-listening app.

`app.ts` is currently a top-level script — it builds the app **and** starts the queue, the
scheduler, a chokidar watcher, and `listen()`. Importing it from `mcp.ts` would boot a second
daemon. The split is clean, though: lines 38–96 are pure construction and route registration;
everything side-effectful starts at line 100. So:

1. Extract `export async function buildApp()` covering the construction half (~15-line
   mechanical change; the bottom half becomes `main()` that calls it).
2. `mcp.ts` calls `buildApp()` → `await app.ready()` → `app.swagger()` — no HTTP, no daemon
   required, no race, and the spec is by definition the one this build's routes declare.
3. `api()` still talks HTTP for actual tool *calls* — those genuinely need the running daemon,
   and now they fail individually with a clear error instead of taking the whole server down.

This makes derivation strictly more reliable than today's two derived tools, rather than
extending a known-fragile path.

**Fallback if (1) proves messier than it looks** — e.g. a route module with import-time side
effects: keep fetching `/docs/json`, but fetch it **once**, wrap it in try/catch, and fall back
to a checked-in `openapi.snapshot.json` that a test asserts matches the live spec. Same
guarantee (server always starts with all tools), one more artifact to keep honest. Prefer (1).

## Testing

New `node/test/mcp-tools.test.ts`, driven by `buildApp()` + `app.swagger()` — no running daemon,
so it works in CI:

| Test | Asserts |
|---|---|
| every manifest entry resolves | each `TOOLS[]` `method`+`path` exists in the spec — a renamed/deleted route fails the build instead of producing a broken tool |
| query params become tool fields | `queue_list` exposes `status`, `tag`, `sort`, `dir`, `schedule_type` — the §2 drift, as a regression test |
| path params become required fields | `queue_session` exposes required `id`, and the handler interpolates it into the URL |
| body params become tool fields | `queue_add` keeps its current field set (regression guard on the 2 already-derived tools) |
| required/optional matches the spec | `folder` required on `teleport_list`, `window` optional |
| enums survive derivation | `queue_list.status` is an enum of the six task statuses, not a bare string |
| `bool01` fields are booleans that serialize to `'0'`/`'1'` | `teleport full=true` produces `?full=1` |
| tool names are unique and stable | a snapshot of the registered tool-name list — renaming a tool is a breaking change to users' agents and must be deliberate |
| no daemon required to register | tools register with nothing listening on 47290 (the §5 failure, as a regression test) |

The first test is the one that ends drift: it fails the moment a route and its tool disagree.

## Migration

Incremental and verifiable at each step — no big-bang rewrite:

1. Extract `buildApp()`; `mcp.ts` sources the spec in-process. Behavior unchanged, §5 fixed.
2. Extend `buildZodShape`/`propToZod` to consume `parameters[]` alongside `requestBody`. Still
   no tools converted; unit-tested on its own.
3. Add the manifest + generic registrar. Convert tools in batches, easiest first (single path
   param: `queue_get`, `queue_cancel`, `queue_force_run`, `queue_session`, `queue_artifacts`,
   `set_default_provider`, `task_prompt_versions`). Each batch: convert, run the suite, confirm
   the tool's schema is unchanged except where drift is being *fixed*.
4. Convert the teleport tools and `queue_list` (where schemas legitimately change — call this out
   in the changelog; `queue_list` gains five filter fields).
5. Delete `fetchBodySchema` and the last hand-written `server.tool()` schema blocks. Update the
   `mcp.ts` header so it describes what the file actually does.
6. Separately (not blocking): decide which of the ~20 unexposed operations in §4 should become
   tools. With the manifest in place, each is a one-line entry.

`update_settings` is the expected holdout: its 10 fields are typed as `z.string()`/`z.enum` in
the tool while the route takes a free-form settings object. Either give `POST /settings` a real
property schema (better — it documents the daemon's settings surface for every client, not just
MCP) or leave it hand-written and say so in a comment. Not a blocker either way.

## Decisions

1. **Derive schemas, hand-write identity.** The spec has no `operationId` and its `summary`
   fields are written for humans browsing `/docs`; good MCP descriptions carry usage guidance
   that doesn't belong in REST docs. Names and descriptions stay in the manifest.
2. **A manifest, not auto-exposure of every route.** What an agent should be able to do is an
   editorial decision. Removing schema duplication doesn't require surrendering it — and
   auto-exposing would immediately publish `/healthz`, `/open-folder`, and the static UI routes.
3. **In-process spec over HTTP fetch.** Removes the cold-start race, the network dependency, and
   the total-failure mode in one move, and guarantees the spec matches the running build.
4. **Wire format is frozen; `bool01` absorbs the mismatch.** Two fields aren't worth breaking
   documented `curl` commands over.
5. **A test that resolves every manifest entry against the spec.** Drift ends because a route
   change that orphans a tool fails the suite — not because a convention says don't duplicate.
6. **Migrate incrementally.** 28 tools converted in one commit is unreviewable; the manifest
   pattern coexists with hand-written `server.tool()` calls indefinitely.

## Status

**Built.** §Migration steps 1–5 are done, in one pass rather than incrementally (verified at
each stage: `tsc --noEmit`, the full test suite, and live MCP-protocol smoke tests against both
a stopped and a running daemon).

1. `buildApp()` extracted from `app.ts` — pure construction (Fastify instance, OpenAPI/static
   registration, all route modules), returned without `listen()`. `main()` covers everything
   side-effectful (queue, scheduler, watcher, poller, `listen()`), gated behind an entry-point
   check (`import.meta.url === file://${process.argv[1]}`) so importing `buildApp` from `mcp.ts`
   never boots a second daemon.
2. `mcp.ts` sources its OpenAPI spec via `buildApp()` → `app.ready()` → `app.swagger()` — no HTTP
   fetch, no dependency on the daemon being up. Verified: `RESTWALKER_URL` pointed at a closed
   port still registers all 28 tools (the exact §5 failure, now fixed).
3. `propToZod`/`buildZodShape` extended with `operationFields()`, which additionally reads
   `parameters[]` (query + path) alongside `requestBody`, and returns a `FieldLoc[]` recording
   where each field belongs on the wire.
4. A `TOOLS: ToolDef[]` manifest (name + method + path + description + optional per-field
   `describe`/`omit`/`bool01`) replaces 24 of the 26 previously hand-written `server.tool()`
   blocks, registered by one generic `registerManifestTool()`. The wire-request assembly itself
   (`buildRequest()`) is a pure function, independent of the fetch call, so it's unit-testable
   without a running daemon.
   - `queue_list` gained `status`, `schedule_type`, `sort`, `dir`, `tag` — the exact drift
     documented in §2 above, closed as a side effect of deriving instead of duplicating.
   - `can_run` gained `project`.
   - Two holdouts stay hand-written, as anticipated in the Migration section: `task_prompt_save`
     (cross-endpoint routing on `origin_id`, though its Zod shape is still pulled from the spec)
     and `update_settings` (the route takes a free-form settings object with no fixed property
     schema to derive from).
5. `fetchBodySchema` (the old HTTP-fetch-based, request-body-only derivation) is gone; the file
   header now describes what it actually does.
6. New `node/test/mcp-tools.test.ts` (10 tests, per the §Testing table): every manifest entry
   resolves against the spec, the `queue_list`/`queue_add` drift regressions, required/optional
   fidelity, enum survival, `bool01` round-tripping (including the zod v4 gotcha below), path/body
   wire assembly, and a tool-name snapshot.

One implementation detail not anticipated in the design: in zod v4, wrapping a schema in
`.optional()` produces a new object whose *own* `.description` is `undefined` — it does not
delegate to the inner type. The original plan for `bool01` (build the field normally, then
re-describe it as boolean by reading `.description` off the already-optional-wrapped schema)
silently dropped the description. Fixed by building the boolean field directly from the spec's
description text inside `operationFields()`, before `.optional()` ever runs, rather than by
introspecting the zod object afterward.

Deliberately not done (§Migration step 6, non-goal §2): no new tools were added for the ~20
spec operations that have none today (`/queue/tags`, `/artifacts/{id}/content`, provider
PUT/DELETE, etc.). That remains an explicit, separate editorial decision.

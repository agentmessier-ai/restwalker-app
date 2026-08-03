import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { z } from 'zod'

// mcp.ts's derivation reads the app's OpenAPI spec in-process (buildApp().swagger()),
// which transitively opens the sqlite db at import time — so point that at a temp
// path BEFORE importing, same pattern as teleport.test.ts.
let mcp: typeof import('../mcp.js')
let spec: import('../mcp.js').OApiSpec
let root: string

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'mcp-tools-fixture-'))
  process.env.RESTWALKER_DB = join(root, 'rw.db')
  process.env.CLAUDE_PROJECTS_DIR = join(root, 'projects')

  const { buildApp } = await import('../app.js')
  const app = await buildApp()   // never listens — no daemon required
  await app.ready()
  spec = app.swagger() as unknown as import('../mcp.js').OApiSpec

  mcp = await import('../mcp.js')
})

after(() => rmSync(root, { recursive: true, force: true }))

test('every manifest entry resolves against the spec', () => {
  for (const def of mcp.TOOLS) {
    assert.doesNotThrow(
      () => mcp.operationFields(spec, def.method, def.path, def.describe, def.bool01),
      `${def.name}: ${def.method} ${def.path} not found in spec`,
    )
  }
})

test('no daemon required to register — spec resolves with nothing listening', () => {
  // buildApp() above never called app.listen(); resolving every tool's fields
  // against that spec (done in the previous test) is itself the proof. This
  // test just documents the guarantee explicitly.
  assert.ok(mcp.TOOLS.length > 0)
})

test('query params become tool fields (queue_list drift regression)', () => {
  const def = mcp.TOOLS.find(t => t.name === 'queue_list')!
  const { shape } = mcp.operationFields(spec, def.method, def.path, def.describe, def.bool01)
  for (const field of ['limit', 'offset', 'status', 'schedule_type', 'sort', 'dir', 'tag']) {
    assert.ok(shape[field], `queue_list should expose ${field}`)
  }
})

test('path params become required fields (queue_session)', () => {
  const def = mcp.TOOLS.find(t => t.name === 'queue_session')!
  const { shape, locs } = mcp.operationFields(spec, def.method, def.path, def.describe, def.bool01)
  assert.ok(shape.id)
  assert.equal(shape.id.isOptional(), false)
  assert.deepEqual(locs.find(l => l.name === 'id'), { name: 'id', loc: 'path' })
})

test('body params become tool fields (queue_add regression)', () => {
  const def = mcp.TOOLS.find(t => t.name === 'queue_add')!
  const { shape, locs } = mcp.operationFields(spec, def.method, def.path, def.describe, def.bool01)
  for (const field of ['description', 'cwd', 'model', 'provider_id', 'schedule',
                        'webhook_pre_url', 'webhook_post_url', 'webhook_timeout_s',
                        'webhook_retry', 'webhook_ignore_ssl', 'timeout_s']) {
    assert.ok(shape[field], `queue_add should expose ${field}`)
    assert.equal(locs.find(l => l.name === field)?.loc, 'body')
  }
})

test('required/optional matches the spec (queue_add)', () => {
  const def = mcp.TOOLS.find(t => t.name === 'queue_add')!
  const { shape } = mcp.operationFields(spec, def.method, def.path, def.describe, def.bool01)
  assert.equal(shape.description.isOptional(), false)
  assert.equal(shape.cwd.isOptional(), true)
})

test('enums survive derivation (queue_list.status)', () => {
  const def = mcp.TOOLS.find(t => t.name === 'queue_list')!
  const { shape } = mcp.operationFields(spec, def.method, def.path, def.describe, def.bool01)
  const inner = shape.status.unwrap()   // strip the optional() wrapper
  assert.deepEqual([...inner.options].sort(), ['cancelled', 'done', 'failed', 'pending', 'running', 'scheduled'])
})

// No REGISTERED tool currently declares bool01 (the teleport tools that did are
// no longer exposed over MCP), but the derivation machinery is still live and a
// silently-broken '0'/'1' coercion would be a nasty regression for the next tool
// that needs one. Drive it with a synthetic def against a real spec path — the
// /teleport/* HTTP routes still exist and still declare `full` as a '0'/'1' enum.
test('bool01 fields are booleans that serialize to \'0\'/\'1\' on the wire', () => {
  const def: typeof mcp.TOOLS[number] = {
    name: 'synthetic_bool01', method: 'GET', path: '/teleport/conversation',
    description: 'fixture', bool01: ['full'],
  }
  const { shape, locs } = mcp.operationFields(spec, def.method, def.path, def.describe, def.bool01)
  assert.ok(shape.full.unwrap() instanceof z.ZodBoolean, 'full should be a boolean field on the tool, not the wire string enum')
  assert.equal(shape.full.isOptional(), true)

  const req1 = mcp.buildRequest(def, locs, { folder: 'myapp', full: true })
  assert.equal(req1.query?.full, '1')
  const req2 = mcp.buildRequest(def, locs, { folder: 'myapp', full: false })
  assert.equal(req2.query?.full, undefined)
  const req3 = mcp.buildRequest(def, locs, { folder: 'myapp' })
  assert.equal(req3.query?.full, undefined)
})

test('buildRequest substitutes path params and splits query/body correctly', () => {
  const getDef = mcp.TOOLS.find(t => t.name === 'queue_get')!
  const { locs: getLocs } = mcp.operationFields(spec, getDef.method, getDef.path, getDef.describe, getDef.bool01)
  const getReq = mcp.buildRequest(getDef, getLocs, { id: 42 })
  assert.equal(getReq.path, '/queue/42')
  assert.equal(getReq.query, undefined)
  assert.equal(getReq.body, undefined)

  const addDef = mcp.TOOLS.find(t => t.name === 'queue_add')!
  const { locs: addLocs } = mcp.operationFields(spec, addDef.method, addDef.path, addDef.describe, addDef.bool01)
  const addReq = mcp.buildRequest(addDef, addLocs, { description: 'hi', cwd: '/tmp' })
  assert.equal(addReq.path, '/queue')
  assert.equal(addReq.query, undefined)
  assert.deepEqual(addReq.body, { description: 'hi', cwd: '/tmp' })
})

test('tool names are unique and match the expected registered set', () => {
  const names = mcp.TOOLS.map(t => t.name)
  assert.equal(new Set(names).size, names.length, 'no duplicate tool names in the manifest')
  // Snapshot: renaming/removing a tool here is a breaking change for users'
  // agents and must be deliberate, not an accidental side effect of a refactor.
  assert.deepEqual([...names].sort(), [
    'add_provider', 'can_run', 'get_settings', 'list_models', 'list_projects',
    'list_providers', 'queue_add', 'queue_artifacts', 'queue_cancel',
    'queue_force_run', 'queue_get', 'queue_list', 'queue_session', 'queue_stats',
    'set_default_provider', 'status', 'sync', 'system_prompt_get',
    'system_prompt_set', 'task_prompt_versions', 'usage_history',
  ])
})

// The teleport tools were removed deliberately (the standalone `teleport`
// project owns that surface now). Assert their ABSENCE so a stray revert or a
// merge that resurrects them fails loudly instead of quietly re-introducing a
// second, weaker-authenticated cross-session tool alongside tp's.
test('teleport tools are no longer exposed over MCP', () => {
  const teleportish = mcp.TOOLS.map(t => t.name).filter(n => n.startsWith('teleport'))
  assert.deepEqual(teleportish, [])
})

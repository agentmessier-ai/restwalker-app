import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Teleport core touches the db barrel (for CLAUDE_PROJECTS_DIR) which opens a
// sqlite file on import — so point both at temp dirs BEFORE importing, and load
// teleport dynamically so it reads our env.
let tp: typeof import('../teleport.js')
let root: string

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'tp-fixture-'))
  process.env.CLAUDE_PROJECTS_DIR = root
  process.env.RESTWALKER_DB = join(root, 'rw.db')

  const dir = join(root, '-Users-test-dev-myapp')
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const at = (msAgo: number) => new Date(now - msAgo).toISOString()
  const lines = [
    JSON.stringify({ type: 'queue-operation', timestamp: at(9000) }),                       // ignored (no cwd)
    JSON.stringify({ type: 'user',      cwd: '/Users/test/dev/myapp', timestamp: at(3000), message: { content: 'hello world' } }),
    JSON.stringify({ type: 'assistant', cwd: '/Users/test/dev/myapp', timestamp: at(2000), gitBranch: 'main',
                     message: { content: [{ type: 'text', text: 'hi there' }, { type: 'tool_use', name: 'Read', input: { file: 'x' } }] } }),
    JSON.stringify({ type: 'user',      cwd: '/Users/test/dev/myapp', timestamp: at(1000),
                     message: { content: [{ type: 'tool_result', content: 'X'.repeat(5000), is_error: false }] } }),
    JSON.stringify({ type: 'user',      cwd: '/Users/test/dev/myapp', timestamp: at(48 * 3600_000), message: { content: 'too old' } }), // outside window
  ]
  writeFileSync(join(dir, 'sess-1.jsonl'), lines.join('\n'))
  tp = await import('../teleport.js')
})

after(() => rmSync(root, { recursive: true, force: true }))

test('parseWindow: units and default', () => {
  assert.equal(tp.parseWindow('6h'), 6 * 3600_000)
  assert.equal(tp.parseWindow(), 6 * 3600_000)         // default 6h
  assert.equal(tp.parseWindow('30m'), 30 * 60_000)
  assert.equal(tp.parseWindow('2d'), 2 * 86_400_000)
  assert.equal(tp.parseWindow('garbage'), 6 * 3600_000)
})

test('resolveFolders: by name, path, substring', () => {
  assert.equal(tp.resolveFolders('myapp')[0]?.path, '/Users/test/dev/myapp')
  assert.equal(tp.resolveFolders('/Users/test/dev/myapp')[0]?.path, '/Users/test/dev/myapp')
  assert.equal(tp.resolveFolders('dev/myapp').length, 1)
  assert.equal(tp.resolveFolders('nothing-here').length, 0)
})

test('listConversations: window filter + metadata', () => {
  const c = tp.listConversations('myapp', tp.parseWindow('24h'))
  assert.equal(c.length, 1)
  assert.equal(c[0].message_count, 3)                  // 3 in-window user/assistant, "too old" excluded
  assert.match(c[0].first_user_request, /hello world/)
  assert.equal(c[0].git_branch, 'main')
})

test('getRawConversation: raw turns + tool calls', () => {
  const r = tp.getRawConversation({ query: 'myapp', windowMs: tp.parseWindow('24h') })
  assert.ok('turns' in r)
  if ('turns' in r) {
    assert.equal(r.turn_count, 3)
    assert.equal(r.turns[0].text, 'hello world')
    assert.equal(r.turns[1].tool_uses?.[0].name, 'Read')
    assert.equal(r.turns[2].tool_results?.[0].is_error, false)
  }
})

test('getRawConversation: per-item truncation of large tool output', () => {
  const r = tp.getRawConversation({ query: 'myapp', windowMs: tp.parseWindow('24h') })
  assert.ok('turns' in r)
  if ('turns' in r) {
    const res = r.turns[2].tool_results?.[0].content ?? ''
    assert.ok(res.length < 5000, 'large tool result should be truncated')
    assert.match(res, /\+\d+ chars/)
  }
  const full = tp.getRawConversation({ query: 'myapp', windowMs: tp.parseWindow('24h'), full: true })
  assert.ok('turns' in full)
  if ('turns' in full) assert.equal(full.turns[2].tool_results?.[0].content.length, 5000)  // full=1 keeps it
})

test('getRawConversation: unknown folder -> error', () => {
  const r = tp.getRawConversation({ query: 'nope-xyz', windowMs: 3600_000 })
  assert.ok('error' in r)
})

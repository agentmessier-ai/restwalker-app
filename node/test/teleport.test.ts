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

  // Dedicated fixture for `before`/paging: 10 turns, 20k chars of text each (200k
  // total), so the TOTAL_CAP (150k) drops the oldest few and paging has something
  // to reveal. Oldest first in the file, matching real transcript order.
  const bigDir = join(root, '-Users-test-dev-bigapp')
  mkdirSync(bigDir, { recursive: true })
  const bigText = (n: number) => `turn-${n}-` + 'Y'.repeat(20000)
  const bigLines = Array.from({ length: 10 }, (_, i) =>
    JSON.stringify({ type: 'user', cwd: '/Users/test/dev/bigapp', timestamp: at((10 - i) * 10_000),
                     message: { content: bigText(i) } }))
  writeFileSync(join(bigDir, 'sess-big.jsonl'), bigLines.join('\n'))

  // Fixtures for teleport_search: two folders sharing a phrase (folder-omitted
  // sweep), one tool-use-only turn with no prose (the motivating case), and a
  // folder with many matches (limit/truncation).
  const searchDirA = join(root, '-Users-test-dev-searcha')
  mkdirSync(searchDirA, { recursive: true })
  writeFileSync(join(searchDirA, 'sess-a.jsonl'), [
    JSON.stringify({ type: 'user', cwd: '/Users/test/dev/searcha', timestamp: at(5000), message: { content: 'the quick brown fox jumps' } }),
    JSON.stringify({ type: 'assistant', cwd: '/Users/test/dev/searcha', timestamp: at(4000),
                     message: { content: [{ type: 'tool_use', name: 'mcp__plugin_pattern8_pattern8__pattern_search', input: {} }] } }),
  ].join('\n'))

  const searchDirB = join(root, '-Users-test-dev-searchb')
  mkdirSync(searchDirB, { recursive: true })
  writeFileSync(join(searchDirB, 'sess-b.jsonl'), [
    JSON.stringify({ type: 'user', cwd: '/Users/test/dev/searchb', timestamp: at(5000), message: { content: 'the quick brown fox again' } }),
  ].join('\n'))

  const searchDirC = join(root, '-Users-test-dev-searchc')
  mkdirSync(searchDirC, { recursive: true })
  writeFileSync(join(searchDirC, 'sess-c.jsonl'),
    Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ type: 'user', cwd: '/Users/test/dev/searchc', timestamp: at(1000 * (i + 1)), message: { content: `zzzmatch-${i}` } })
    ).join('\n'))

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

test('getRawConversation: no before = unchanged', () => {
  const r = tp.getRawConversation({ query: 'myapp', windowMs: tp.parseWindow('24h') })
  assert.ok('turns' in r)
  if ('turns' in r) assert.equal(r.turn_count, 3)   // same as the pre-`before` behavior
})

test('getRawConversation: before bounds the end', () => {
  const r0 = tp.getRawConversation({ query: 'myapp', windowMs: tp.parseWindow('24h') })
  assert.ok('turns' in r0)
  if (!('turns' in r0)) return
  const before = r0.turns[1].ts   // ts of the 'hi there' assistant turn
  assert.ok(before)
  const r = tp.getRawConversation({ query: 'myapp', windowMs: tp.parseWindow('24h'), before: before! })
  assert.ok('turns' in r)
  if ('turns' in r) {
    assert.equal(r.turn_count, 1)          // only the strictly-older 'hello world' turn survives
    assert.equal(r.turns[0].text, 'hello world')
    assert.equal(r.window.until, new Date(before!).toISOString())
  }
})

test('getRawConversation: before pages through a truncated session', () => {
  const page1 = tp.getRawConversation({ query: 'bigapp', windowMs: tp.parseWindow('24h') })
  assert.ok('turns' in page1)
  if (!('turns' in page1)) return
  assert.equal(page1.truncated, true)
  assert.equal(page1.turn_count, 7)                 // 3 of 10 oldest turns dropped by TOTAL_CAP
  assert.ok(page1.turns.every(t => !t.text.startsWith('turn-0-') && !t.text.startsWith('turn-1-') && !t.text.startsWith('turn-2-')))

  const earliest = page1.turns[0].ts
  assert.ok(earliest)
  const page2 = tp.getRawConversation({ query: 'bigapp', windowMs: tp.parseWindow('24h'), before: earliest! })
  assert.ok('turns' in page2)
  if ('turns' in page2) {
    assert.equal(page2.truncated, false)
    assert.equal(page2.turn_count, 3)               // exactly the turns page1 dropped
    const prefixes = page2.turns.map(t => t.text.slice(0, 8)).sort()
    assert.deepEqual(prefixes, ['turn-0-Y', 'turn-1-Y', 'turn-2-Y'])
    // no overlap: none of page2's turns share a timestamp with page1's
    const page1Ts = new Set(page1.turns.map(t => t.ts))
    assert.ok(page2.turns.every(t => !page1Ts.has(t.ts)))
  }
})

test('teleport_search: finds text matches', () => {
  const r = tp.searchConversations({ query: 'quick brown fox', folder: 'searcha', windowMs: tp.parseWindow('24h') })
  assert.ok('matches' in r)
  if ('matches' in r) {
    const hit = r.matches.find(m => m.kind === 'text')
    assert.ok(hit)
    assert.equal(hit!.session_id, 'sess-a')
    assert.match(hit!.excerpt, /quick brown fox/)
  }
})

test('teleport_search: finds tool-name matches', () => {
  const r = tp.searchConversations({ query: 'pattern_search', folder: 'searcha', windowMs: tp.parseWindow('24h') })
  assert.ok('matches' in r)
  if ('matches' in r) {
    const hit = r.matches.find(m => m.kind === 'tool_use')
    assert.ok(hit, 'should find the tool-use whose call carries no prose')
    assert.equal(hit!.excerpt, 'mcp__plugin_pattern8_pattern8__pattern_search')
  }
})

test('teleport_search: folder omitted searches all folders', () => {
  const r = tp.searchConversations({ query: 'quick brown fox', windowMs: tp.parseWindow('24h') })
  assert.ok('matches' in r)
  if ('matches' in r) {
    const paths = new Set(r.matches.map(m => m.project_path))
    assert.ok(paths.has('/Users/test/dev/searcha'))
    assert.ok(paths.has('/Users/test/dev/searchb'))
  }
})

test('teleport_search: limit caps and flags truncated', () => {
  const r = tp.searchConversations({ query: 'zzzmatch', folder: 'searchc', windowMs: tp.parseWindow('24h'), limit: 3 })
  assert.ok('matches' in r)
  if ('matches' in r) {
    assert.equal(r.matches.length, 3)
    assert.equal(r.truncated, true)
  }
})

test('teleport_search: sessions_scanned reflects coverage', () => {
  const r = tp.searchConversations({ query: 'nonexistent-xyz-query', folder: 'searcha', windowMs: tp.parseWindow('24h') })
  assert.ok('matches' in r)
  if ('matches' in r) {
    assert.equal(r.match_count, 0)
    assert.ok(r.sessions_scanned > 0, '0 matches should still report sessions scanned, distinguishing it from nothing scanned')
  }
})

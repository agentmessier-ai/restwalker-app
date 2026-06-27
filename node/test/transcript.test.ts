import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTranscriptLine } from '../transcript.js'

test('parseTranscriptLine: skips blank, malformed, and non-message lines', () => {
  assert.equal(parseTranscriptLine(''), null)
  assert.equal(parseTranscriptLine('{not json'), null)
  assert.equal(parseTranscriptLine(JSON.stringify({ type: 'queue-operation' })), null)
})

test('parseTranscriptLine: user string content', () => {
  const e = parseTranscriptLine(JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'hello' } }))!
  assert.equal(e.type, 'user')
  assert.equal(e.text, 'hello')
  assert.deepEqual(e.textBlocks, ['hello'])
  assert.equal(e.ts, '2026-01-01T00:00:00Z')
})

test('parseTranscriptLine: assistant text + thinking + tool_use, usage + gitBranch', () => {
  const e = parseTranscriptLine(JSON.stringify({
    type: 'assistant', gitBranch: 'main',
    message: {
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'x' } },
      ],
    },
  }))!
  assert.equal(e.gitBranch, 'main')
  assert.deepEqual(e.textBlocks, ['A', 'B'])      // blocks preserved for caller-specific joins
  assert.equal(e.text, 'AB')                       // convenience join('')
  assert.equal(e.thinking, 'hmm')
  assert.equal(e.toolUses[0].name, 'Read')
  assert.deepEqual(e.toolUses[0].input, { file: 'x' })
  assert.equal(e.usage.input_tokens, 10)
  assert.equal(e.usage.output_tokens, 5)
})

test('parseTranscriptLine: user tool_result keeps raw content + error flag', () => {
  const e = parseTranscriptLine(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ text: 'out' }], is_error: true }] },
  }))!
  assert.equal(e.toolResults[0].id, 't1')
  assert.equal(e.toolResults[0].is_error, true)
  assert.deepEqual(e.toolResults[0].content, [{ text: 'out' }])   // raw, not stringified
})

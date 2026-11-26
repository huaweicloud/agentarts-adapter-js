import test from 'node:test'
import assert from 'node:assert/strict'

import { CHARS_PER_TOKEN, createRecallMessage, extractQuery, renderRecallBlock } from '../src/recall.js'

const LIMITS = { maxInjectTokens: 600, minScore: 0.35 }

test('extractQuery joins text blocks and ignores non-text blocks', () => {
  const messages = [
    { content: [{ type: 'text', text: '第一段' }, { type: 'image', url: 'x' }] },
    { content: [{ type: 'text', text: 'second   part' }] },
  ]
  assert.equal(extractQuery(messages), '第一段 second part')
})

test('extractQuery tolerates a bare string and junk input', () => {
  assert.equal(extractQuery([{ content: 'hello' }]), 'hello')
  assert.equal(extractQuery(undefined), '')
  assert.equal(extractQuery([{ content: null }]), '')
})

test('renderRecallBlock drops hits under minScore and orders by score', () => {
  const { block, included } = renderRecallBlock(
    [
      { content: 'low', score: 0.1, strategyType: 'semantic' },
      { content: 'high', score: 0.9, strategyType: 'user_preference' },
      { content: 'mid', score: 0.5, strategyType: 'episodic' },
    ],
    LIMITS,
  )
  const lines = block.split('\n')
  assert.match(lines[0], /AgentArts memory/)
  assert.match(lines[1], /0\.90.*user_preference.*high/)
  assert.match(lines[2], /0\.50.*episodic.*mid/)
  assert.equal(lines.length, 3, 'low-score hit must be dropped')
  assert.deepEqual(included.map((hit) => hit.content), ['high', 'mid'])
})

test('renderRecallBlock returns empty text when nothing qualifies', () => {
  assert.deepEqual(renderRecallBlock([], LIMITS), { block: '', included: [] })
  assert.deepEqual(renderRecallBlock([{ content: 'x', score: 0.01 }], LIMITS), { block: '', included: [] })
  assert.deepEqual(renderRecallBlock([{ content: '', score: 0.9 }], LIMITS), { block: '', included: [] })
})

test('renderRecallBlock respects the token budget', () => {
  const hits = Array.from({ length: 40 }, (_, i) => ({
    content: `memory-${i}-` + 'x'.repeat(80),
    score: 0.9 - i * 0.01,
  }))
  const budget = { maxInjectTokens: 100, minScore: 0 }
  const { block, included } = renderRecallBlock(hits, budget)
  assert.ok(block.length <= 100 * CHARS_PER_TOKEN, `block ${block.length} chars exceeds budget`)
  const kept = block.split('\n').length - 1
  assert.ok(kept > 0 && kept < hits.length, `expected truncation, kept ${kept}`)
  // Only the emitted hits may be marked as injected; the rest stay eligible.
  assert.equal(included.length, kept)
  assert.ok(included.every((hit) => block.includes(hit.content)))
})

test('createRecallMessage builds a frozen, identified user message', () => {
  const message = createRecallMessage('ctx')
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length >= 32)
  assert.deepEqual(message.source, { kind: 'user' })
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, 'ctx')
  assert.ok(Object.isFrozen(message))
  assert.ok(Object.isFrozen(message.content))
  assert.throws(() => {
    message.content.push({ type: 'text', text: 'nope' })
  })
  assert.notEqual(createRecallMessage('ctx').id, message.id)
})

test('createRecallMessage ids are unique across many calls', () => {
  const ids = new Set(Array.from({ length: 200 }, () => createRecallMessage('x').id))
  assert.equal(ids.size, 200)
})

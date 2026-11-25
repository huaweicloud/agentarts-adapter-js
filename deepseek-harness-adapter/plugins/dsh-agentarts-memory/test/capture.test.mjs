import test from 'node:test'
import assert from 'node:assert/strict'

import { flattenBlocks, normalizeUserText, renderTurns, TURN_CHAR_LIMIT } from '../src/capture.js'

const userEvent = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
const assistantEvent = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })

test('flattenBlocks joins text blocks only', () => {
  assert.equal(flattenBlocks([{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'x' }]), 'a')
  assert.equal(flattenBlocks('direct'), 'direct')
  assert.equal(flattenBlocks(undefined), '')
})

test('renderTurns keeps dialogue and drops tool traffic', () => {
  const events = [
    userEvent('hi'),
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', data: { message: { content: [{ content: [{ type: 'text', text: 'secret' }] }] } } },
    assistantEvent('hello'),
  ]
  assert.deepEqual(renderTurns(events, 10), [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ])
})

test('normalizeUserText unwraps the AgentRun envelope and drops runtime reminders', () => {
  const envelope = JSON.stringify({ eventId: 'event-1', attempt: 1, prompt: '我的项目代号是 NEBULA-7421', recall: { memory: [] } })
  assert.equal(normalizeUserText(envelope), '我的项目代号是 NEBULA-7421')
  assert.equal(normalizeUserText('<system-reminder>\ninjected runtime context\n</system-reminder>'), '')
  assert.equal(normalizeUserText('ordinary user text'), 'ordinary user text')
  assert.deepEqual(renderTurns([
    userEvent(envelope),
    userEvent('<system-reminder>\ninjected runtime context\n</system-reminder>'),
    assistantEvent('已了解'),
  ], 10), [
    { role: 'user', content: '我的项目代号是 NEBULA-7421' },
    { role: 'assistant', content: '已了解' },
  ])
})

test('renderTurns keeps the newest turns and honours the cap', () => {
  const events = [userEvent('one'), assistantEvent('two'), userEvent('three'), assistantEvent('four')]
  assert.deepEqual(renderTurns(events, 2), [
    { role: 'user', content: 'three' },
    { role: 'assistant', content: 'four' },
  ])
})

test('renderTurns truncates one oversized turn', () => {
  const [turn] = renderTurns([userEvent('x'.repeat(TURN_CHAR_LIMIT + 500))], 5)
  assert.equal(turn.content.length, TURN_CHAR_LIMIT)
})

test('renderTurns skips empty content and junk events', () => {
  const events = [userEvent(''), { type: 'turn/start' }, null, { type: 'user/message' }]
  assert.deepEqual(renderTurns(events, 5), [])
  assert.deepEqual(renderTurns(undefined, 5), [])
})

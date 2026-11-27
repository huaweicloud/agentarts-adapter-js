import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveAllowList } from '../src/config.js'

function withEnv(value, fn) {
  const prev = process.env.AGENTARTS_ALLOWED_TOOLS
  if (value === undefined) delete process.env.AGENTARTS_ALLOWED_TOOLS
  else process.env.AGENTARTS_ALLOWED_TOOLS = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.AGENTARTS_ALLOWED_TOOLS
    else process.env.AGENTARTS_ALLOWED_TOOLS = prev
  }
}

test('wildcard disables the restriction', () => {
  const r = withEnv(JSON.stringify(['*', 'bash', 'read_file']), () => resolveAllowList({}))
  assert.deepEqual(r, { wildcard: true, tools: [], unknown: [] })
})

test('maps platform capability names to DSH tool names', () => {
  const r = withEnv(
    JSON.stringify(['read_file', 'write_file', 'edit_file', 'list_files', 'glob', 'grep', 'bash']),
    () => resolveAllowList({}),
  )
  assert.equal(r.wildcard, false)
  assert.deepEqual([...r.tools].sort(), ['bash', 'edit', 'glob', 'grep', 'pwsh', 'read', 'write'])
  assert.deepEqual(r.unknown, [])
})

test('drops unknown capability names', () => {
  const r = withEnv(JSON.stringify(['read_file', 'foo']), () => resolveAllowList({}))
  assert.equal(r.wildcard, false)
  assert.deepEqual(r.tools, ['read'])
  assert.deepEqual(r.unknown, ['foo'])
})

test('falls back to the config allow list without env', () => {
  const r = withEnv(undefined, () => resolveAllowList({ allow: ['write_file'] }))
  assert.equal(r.wildcard, false)
  assert.deepEqual(r.tools, ['write'])
  assert.deepEqual(r.unknown, [])
})
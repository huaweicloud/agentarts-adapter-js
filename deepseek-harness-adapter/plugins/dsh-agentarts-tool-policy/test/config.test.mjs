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

test('no whitelist configured means permit everything', () => {
  const r = withEnv(undefined, () => resolveAllowList({}))
  assert.deepEqual(r, { specified: false, wildcard: false, tools: [], unknown: [] })
})

test('wildcard permits everything even when other names are listed', () => {
  const r = withEnv(JSON.stringify(['*', 'bash', 'read_file']), () => resolveAllowList({}))
  assert.deepEqual(r, { specified: true, wildcard: true, tools: [], unknown: [] })
})

test('maps platform capability names to DSH tool names', () => {
  const r = withEnv(
    JSON.stringify(['read_file', 'write_file', 'edit_file', 'list_files', 'glob', 'grep', 'bash']),
    () => resolveAllowList({}),
  )
  assert.equal(r.specified, true)
  assert.equal(r.wildcard, false)
  assert.deepEqual([...r.tools].sort(), ['bash', 'edit', 'glob', 'grep', 'pwsh', 'read', 'write'])
  assert.deepEqual(r.unknown, [])
})

test('DSH tool names written verbatim are unknown and grant nothing', () => {
  const r = withEnv(JSON.stringify(['read', 'read_image']), () => resolveAllowList({}))
  assert.equal(r.specified, true)
  assert.equal(r.wildcard, false)
  // 只认平台 capability 名；DSH 原生名不是白名单项 → 不授予任何工具 → 全部全局工具被禁。
  assert.deepEqual(r.tools, [])
  assert.deepEqual(r.unknown, ['read', 'read_image'])
})

test('a configured list of only unknown names denies every tool', () => {
  const r = withEnv(JSON.stringify(['not-a-tool']), () => resolveAllowList({}))
  assert.equal(r.specified, true)
  assert.equal(r.wildcard, false)
  assert.deepEqual(r.tools, [])
  assert.deepEqual(r.unknown, ['not-a-tool'])
})

test('an explicit empty array permits everything', () => {
  const r = withEnv('[]', () => resolveAllowList({}))
  assert.deepEqual(r, { specified: false, wildcard: false, tools: [], unknown: [] })
})

test('falls back to the config allow list without env', () => {
  const r = withEnv(undefined, () => resolveAllowList({ allow: ['write_file', 'glob'] }))
  assert.equal(r.specified, true)
  assert.equal(r.wildcard, false)
  assert.deepEqual([...r.tools].sort(), ['glob', 'write'])
  assert.deepEqual(r.unknown, [])
})

test('a real patch row with empty allow [] is not a whitelist (permit everything)', () => {
  // 插件 bundle 的 cordis.patch.yml 每次都带 allow: []；空数组不算"已配置"，
  // 否则默认部署会把所有工具全禁。
  const r = withEnv(undefined, () => resolveAllowList({ allow: [] }))
  assert.deepEqual(r, { specified: false, wildcard: false, tools: [], unknown: [] })
})

test('env empty array and row allow [] both permit everything', () => {
  const r = withEnv('[]', () => resolveAllowList({ allow: [] }))
  assert.deepEqual(r, { specified: false, wildcard: false, tools: [], unknown: [] })
})
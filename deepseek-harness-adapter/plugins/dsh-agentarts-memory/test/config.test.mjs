import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkReady,
  describeSwitches,
  ENV_ENDPOINT,
  ENV_REGION,
  ENV_REGION_ALT,
  ENV_REGION_OS,
  ENV_RERANK,
  ENV_SPACE_ID,
  ENV_USER_ID,
  resolveConfig,
  resolveRegion,
  resolveRerank,
  STRATEGY_TYPES,
} from '../src/config.js'

test('resolveConfig fills every default', () => {
  const config = resolveConfig(undefined, {})
  assert.equal(config.enabled, true)
  assert.equal(config.spaceId, '')
  assert.equal(config.apiKeyEnv, 'HUAWEICLOUD_SDK_MEMORY_API_KEY')
  assert.equal(config.region, 'cn-southwest-2')
  assert.equal(config.actorId, 'dsh-user')
  assert.equal(config.endpoint, '')
  assert.equal(config.rerank, true)
  assert.deepEqual(
    { ...config.recall },
    { enabled: true, topK: 5, minScore: 0.35, maxInjectTokens: 600, cacheMs: 60000, minQueryChars: 8 },
  )
  assert.equal(config.tools.enabled, true)
  // Capture is deliberately opt-in.
  assert.equal(config.capture.enabled, false)
})

test('resolveConfig reads deployment coordinates from the environment', () => {
  const config = resolveConfig(
    {},
    {
      [ENV_SPACE_ID]: '  env-space  ',
      [ENV_REGION]: 'cn-north-4',
      [ENV_ENDPOINT]: 'https://memory.internal.example',
      [ENV_USER_ID]: 'env-user',
      [ENV_RERANK]: 'false',
    },
  )
  assert.equal(config.spaceId, 'env-space')
  assert.equal(config.region, 'cn-north-4')
  assert.equal(config.endpoint, 'https://memory.internal.example')
  assert.equal(config.actorId, 'env-user')
  assert.equal(config.rerank, false)
})

test('the environment wins over the patch row (hosted deployment contract)', () => {
  const config = resolveConfig(
    {
      spaceId: 'row-space',
      region: 'row-region',
      endpoint: 'https://row.example',
      actorId: 'row-user',
      rerank: false,
    },
    {
      [ENV_SPACE_ID]: 'env-space',
      [ENV_REGION]: 'env-region',
      [ENV_ENDPOINT]: 'https://env.example',
      [ENV_USER_ID]: 'env-user',
      [ENV_RERANK]: '1',
    },
  )
  assert.equal(config.spaceId, 'env-space')
  assert.equal(config.region, 'env-region')
  assert.equal(config.endpoint, 'https://env.example')
  assert.equal(config.actorId, 'env-user')
  assert.equal(config.rerank, true)
})

test('the patch row is the fallback when the environment is empty', () => {
  const config = resolveConfig(
    { spaceId: 'row-space', region: 'row-region', actorId: 'row-user', endpoint: 'https://row.example' },
    {},
  )
  assert.equal(config.spaceId, 'row-space')
  assert.equal(config.region, 'row-region')
  assert.equal(config.actorId, 'row-user')
  assert.equal(config.endpoint, 'https://row.example')
})

test('resolveRegion follows the SDK chain and keeps the row as fallback', () => {
  assert.equal(resolveRegion({ region: 'row' }, { [ENV_REGION]: 'a', [ENV_REGION_ALT]: 'b', [ENV_REGION_OS]: 'c' }), 'a')
  assert.equal(resolveRegion({ region: 'row' }, { [ENV_REGION_ALT]: 'b', [ENV_REGION_OS]: 'c' }), 'b')
  assert.equal(resolveRegion({ region: 'row' }, { [ENV_REGION_OS]: 'c' }), 'c')
  assert.equal(resolveRegion({ region: 'row' }, {}), 'row')
  assert.equal(resolveRegion(undefined, {}), 'cn-southwest-2')
})

test('resolveRerank accepts only the documented boolean spellings', () => {
  assert.equal(resolveRerank({ [ENV_RERANK]: '1' }), true)
  assert.equal(resolveRerank({ [ENV_RERANK]: 'TRUE' }), true)
  assert.equal(resolveRerank({ [ENV_RERANK]: '0' }), false)
  assert.equal(resolveRerank({ [ENV_RERANK]: 'False' }), false)
  assert.equal(resolveRerank({}), true)
  assert.equal(resolveRerank({}, false), false)
  assert.equal(resolveRerank({ [ENV_RERANK]: 'yes' }, false), false)
})

test('resolveConfig keeps explicit switches and clamps numbers', () => {
  const config = resolveConfig(
    {
      enabled: false,
      spaceId: '  sp-123  ',
      recall: { enabled: false, topK: 999, minScore: 9, cacheMs: -1 },
      tools: { enabled: false },
      capture: { enabled: true, maxMessages: 0 },
    },
    {},
  )
  assert.equal(config.enabled, false)
  assert.equal(config.spaceId, 'sp-123')
  assert.equal(config.recall.enabled, false)
  assert.equal(config.recall.topK, 50)
  assert.equal(config.recall.minScore, 1)
  assert.equal(config.recall.cacheMs, 0)
  assert.equal(config.tools.enabled, false)
  assert.equal(config.capture.enabled, true)
  assert.equal(config.capture.maxMessages, 1)
})

test('resolveConfig ignores wrong types instead of throwing', () => {
  const config = resolveConfig({ enabled: 'yes', timeoutMs: 'soon', recall: { topK: 'many' }, capture: 7 }, {})
  assert.equal(config.enabled, true)
  assert.equal(config.timeoutMs, 5000)
  assert.equal(config.recall.topK, 5)
  assert.equal(config.capture.enabled, false)
})

test('checkReady reports the first missing piece', () => {
  const env = { HUAWEICLOUD_SDK_MEMORY_API_KEY: 'k' }
  assert.deepEqual(checkReady(resolveConfig({ spaceId: 'sp-1' }, env), env), { ok: true })
  assert.equal(checkReady(resolveConfig({ enabled: false, spaceId: 'sp-1' }, env), env).ok, false)
  assert.match(checkReady(resolveConfig({}, env), env).reason, /AGENTARTS_MEMORY_SPACE_ID/)
  assert.match(checkReady(resolveConfig({ spaceId: 'sp-1' }, {}), {}).reason, /HUAWEICLOUD_SDK_MEMORY_API_KEY/)
})

test('checkReady honours a renamed apiKeyEnv', () => {
  const config = resolveConfig({ spaceId: 'sp-1', apiKeyEnv: 'MY_KEY' }, {})
  assert.equal(checkReady(config, { MY_KEY: 'v' }).ok, true)
  assert.equal(checkReady(config, { HUAWEICLOUD_SDK_MEMORY_API_KEY: 'v' }).ok, false)
})

test('describeSwitches lists all four switches', () => {
  const text = describeSwitches(resolveConfig({ recall: { enabled: false } }, {}))
  assert.match(text, /plugin on/)
  assert.match(text, /tools on/)
  assert.match(text, /recall off/)
  assert.match(text, /capture off/)
})

test('strategy types match the backend vocabulary', () => {
  assert.deepEqual(STRATEGY_TYPES, ['semantic', 'episodic', 'user_preference', 'summary', 'procedural'])
})

test('no absolute machine path is baked into the sources', async () => {
  // The resolver may legitimately *find* a path on this machine; what must not
  // ship is a personal absolute path written into the code.
  const { readFile, readdir } = await import('node:fs/promises')
  const files = []
  for (const entry of await readdir(new URL('../src/', import.meta.url))) {
    if (entry.endsWith('.js')) files.push(new URL(`../src/${entry}`, import.meta.url))
  }
  files.push(new URL('../index.js', import.meta.url))
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    assert.ok(!text.includes('/Users/'), `${file.pathname} must not contain an absolute home path`)
  }
})

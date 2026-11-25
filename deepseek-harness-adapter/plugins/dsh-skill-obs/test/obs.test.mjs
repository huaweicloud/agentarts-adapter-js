import assert from 'node:assert/strict'
import { test } from 'node:test'

import { obsObjectKey, resolveObsCredentials } from '../src/obs.js'

test('obsObjectKey builds the agentarts skill object key', () => {
  assert.equal(
    obsObjectKey({ id: 'b58c5df0-3a79-4861-b052-f81c686ff17a', name: 'json-processor' }),
    'agentarts/skills/b58c5df0-3a79-4861-b052-f81c686ff17a/json-processor.zip',
  )
})

test('resolveObsCredentials maps BasicCredentials fields (ak/sk/securityToken)', async () => {
  const credentials = await resolveObsCredentials({}, async () => ({ ak: 'A', sk: 'S', securityToken: 'T' }))
  assert.deepEqual(credentials, { ak: 'A', sk: 'S', stsToken: 'T' })
})

test('resolveObsCredentials uses createCredential env provider when no factory is given', async () => {
  // createCredential() reads process.env (not an injected object), matching the real runtime.
  const previous = { ...process.env }
  process.env.HUAWEICLOUD_SDK_AK = 'env-ak'
  process.env.HUAWEICLOUD_SDK_SK = 'env-sk'
  process.env.HUAWEICLOUD_SDK_SECURITY_TOKEN = 'env-sts'
  try {
    const credentials = await resolveObsCredentials(process.env)
    assert.equal(credentials.ak, 'env-ak')
    assert.equal(credentials.sk, 'env-sk')
    assert.equal(credentials.stsToken, 'env-sts')
  } finally {
    process.env = previous
  }
})

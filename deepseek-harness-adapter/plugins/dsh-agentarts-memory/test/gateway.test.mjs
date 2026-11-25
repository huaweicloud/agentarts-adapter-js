/**
 * Gateway behaviour against a local stub of the AgentArts Memory data plane.
 * No SDK, no network: every assertion here runs on any machine.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  buildSearchBody,
  GatewayError,
  MemoryGateway,
  normalizeHit,
  normalizeSearchResponse,
  resolveBaseUrl,
} from '../src/gateway.js'
import { resolveConfig } from '../src/config.js'

const RECORD = { id: 'mem-1', content: '用户偏好 TypeScript 做新项目', strategy_type: 'user_preference' }

/**
 * Start a stub server that records requests and answers with one canned body.
 *
 * @param {{status?: number, body?: unknown, delayMs?: number, headers?: Record<string,string>}} [options]
 * @returns {Promise<{url: string, requests: object[], close: () => Promise<void>}>}
 */
async function startStub(options = {}) {
  const requests = []
  const status = options.status ?? 200
  const body = options.body ?? { records: [{ record: RECORD, score: 0.91 }] }

  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body: raw === '' ? undefined : JSON.parse(raw),
      })
      const send = () => {
        response.writeHead(status, { 'content-type': 'application/json', ...(options.headers ?? {}) })
        response.end(status === 204 ? undefined : JSON.stringify(body))
      }
      if (options.delayMs !== undefined) setTimeout(send, options.delayMs)
      else send()
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

const gatewayFor = (url, overrides = {}, env = { STUB_KEY: 'stub-key' }) =>
  new MemoryGateway(
    resolveConfig({ spaceId: 'space-1', apiKeyEnv: 'STUB_KEY', endpoint: url, ...overrides }),
    env,
  )

test('resolveBaseUrl prefers the config, then the environment, then the region default', () => {
  assert.equal(resolveBaseUrl({ endpoint: 'https://a.example', region: 'r' }, {}), 'https://a.example')
  assert.equal(
    resolveBaseUrl({ endpoint: '', region: 'r' }, { AGENTARTS_MEMORY_DATA_ENDPOINT: 'https://b.example/' }),
    'https://b.example',
  )
  assert.equal(resolveBaseUrl({ endpoint: '', region: 'cn-southwest-2' }, {}), 'https://memory.cn-southwest-2.huaweicloud-agentarts.com')
  // A bare host gains a scheme, like the SDK does.
  assert.equal(resolveBaseUrl({ endpoint: 'memory.example.com', region: 'r' }, {}), 'https://memory.example.com')
})

test('buildSearchBody matches the SDK filter shape', () => {
  const body = buildSearchBody({
    query: 'q',
    topK: 3,
    minScore: 0.3,
    strategyType: 'semantic',
    actorId: 'dsh-user',
    assistantId: 'dsh',
  })
  assert.deepEqual(body, {
    query: 'q',
    strategy_type: 'semantic',
    actor_id: 'dsh-user',
    assistant_id: 'dsh',
    top_k: 3,
    min_score: 0.3,
    only_actived: false,
    rerank: true,
  })
})

test('buildSearchBody omits empty optional fields', () => {
  const body = buildSearchBody({ query: 'q', topK: 5, minScore: 0.4, actorId: '', assistantId: '' })
  assert.ok(!('actor_id' in body))
  assert.ok(!('assistant_id' in body))
  assert.ok(!('strategy_type' in body))
})

test('normalizeHit reads the {record, score} shape', () => {
  assert.deepEqual(normalizeHit({ record: RECORD, score: 0.87 }), {
    id: 'mem-1',
    content: RECORD.content,
    score: 0.87,
    strategyType: 'user_preference',
  })
})

test('normalizeHit also reads a flat record', () => {
  const hit = normalizeHit({ id: 'm-2', content: 'flat', score: 0.5 })
  assert.equal(hit.id, 'm-2')
  assert.equal(hit.content, 'flat')
  assert.equal(hit.score, 0.5)
})

test('normalizeHit never throws on junk', () => {
  assert.deepEqual(normalizeHit(undefined), { id: '', content: '', score: 0, strategyType: '' })
  assert.deepEqual(normalizeHit({ record: 'text' }), { id: '', content: '', score: 0, strategyType: '' })
})

test('normalizeSearchResponse accepts records and results envelopes', () => {
  assert.equal(normalizeSearchResponse({ records: [{ record: RECORD, score: 0.9 }] }).length, 1)
  assert.equal(normalizeSearchResponse({ results: [{ record: RECORD, score: 0.9 }] }).length, 1)
  assert.equal(normalizeSearchResponse({}).length, 0)
  assert.equal(normalizeSearchResponse(undefined).length, 0)
  // Entries without text are dropped rather than surfaced as empty memories.
  assert.equal(normalizeSearchResponse({ results: [{ record: { id: 'x' }, score: 0.9 }] }).length, 0)
})

test('search sends the Bearer header and the expected body', async () => {
  const stub = await startStub()
  try {
    const hits = await gatewayFor(stub.url).search('typescript 项目')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].content, RECORD.content)

    const [request] = stub.requests
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/core/spaces/space-1/memories/search')
    assert.equal(request.authorization, 'Bearer stub-key')
    assert.equal(request.contentType, 'application/json')
    assert.equal(request.body.query, 'typescript 项目')
    assert.equal(request.body.actor_id, 'dsh-user')
    assert.equal(request.body.top_k, 5)
    assert.equal(request.body.min_score, 0.35)
  } finally {
    await stub.close()
  }
})

test('save posts a memory record and returns its id', async () => {
  const stub = await startStub({ body: { id: 'new-1', content: 'saved text' } })
  try {
    const saved = await gatewayFor(stub.url).save({ content: 'saved text', strategyType: 'semantic' })
    assert.deepEqual(saved, { id: 'new-1', content: 'saved text' })

    const [request] = stub.requests
    assert.equal(request.url, '/v1/core/spaces/space-1/memories')
    assert.equal(request.body.content, 'saved text')
    assert.equal(request.body.strategy_type, 'semantic')
    assert.equal(request.body.actor_id, 'dsh-user')
    // strategy_id is only sent when configured.
    assert.ok(!('strategy_id' in request.body))
  } finally {
    await stub.close()
  }
})

test('remove issues a DELETE on the record path', async () => {
  const stub = await startStub({ status: 204 })
  try {
    await gatewayFor(stub.url).remove('mem-9')
    const [request] = stub.requests
    assert.equal(request.method, 'DELETE')
    assert.equal(request.url, '/v1/core/spaces/space-1/memories/mem-9')
  } finally {
    await stub.close()
  }
})

test('pushMessages creates the session then posts parts-shaped messages', async () => {
  const stub = await startStub({ body: { messages: [{ id: 'a' }, { id: 'b' }] } })
  try {
    const accepted = await gatewayFor(stub.url).pushMessages('session-1', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
    assert.equal(accepted, 2)

    assert.equal(stub.requests.length, 2)
    assert.equal(stub.requests[0].url, '/v1/core/spaces/space-1/sessions')
    assert.deepEqual(stub.requests[0].body, { id: 'session-1', actor_id: 'dsh-user', assistant_id: 'dsh' })

    const push = stub.requests[1]
    assert.equal(push.url, '/v1/core/spaces/space-1/sessions/session-1/messages')
    assert.equal(push.body.is_force_extract, true)
    assert.equal(push.body.idempotency_key, 'session-1')
    assert.deepEqual(push.body.messages[0], { role: 'user', parts: [{ type: 'text', text: 'hi' }], actor_id: 'dsh-user' })
    assert.deepEqual(push.body.messages[1], { role: 'assistant', parts: [{ type: 'text', text: 'hello' }], assistant_id: 'dsh' })
  } finally {
    await stub.close()
  }
})

test('pushMessages tolerates an already-existing session and skips empty input', async () => {
  const stub = await startStub({ status: 409, body: { error_code: 'CONFLICT', error_msg: 'session already exists' } })
  try {
    const gateway = gatewayFor(stub.url)
    assert.equal(await gateway.pushMessages('s', []), 0)
    // Create fails with a conflict; the message push then hits the same 409 body
    // shape and must surface as a GatewayError rather than hang or retry.
    await assert.rejects(gateway.pushMessages('s', [{ role: 'user', content: 'x' }]), (error) => {
      assert.ok(error instanceof GatewayError)
      assert.equal(error.code, 'http')
      return true
    })
  } finally {
    await stub.close()
  }
})

test('an HTTP error surfaces the backend error_code', async () => {
  const stub = await startStub({ status: 400, body: { error_code: 'AgentArts.01020001', error_msg: 'Invalid UUID string' } })
  try {
    await assert.rejects(gatewayFor(stub.url).search('q'), (error) => {
      assert.ok(error instanceof GatewayError)
      assert.equal(error.code, 'http')
      assert.match(error.message, /AgentArts\.01020001/)
      assert.match(error.message, /Invalid UUID string/)
      return true
    })
  } finally {
    await stub.close()
  }
})

test('a slow backend hits the deadline', async () => {
  const stub = await startStub({ delayMs: 300 })
  try {
    await assert.rejects(gatewayFor(stub.url, { timeoutMs: 100 }).search('q'), (error) => {
      assert.equal(error.code, 'timeout')
      assert.match(error.message, /exceeded 100ms/)
      return true
    })
  } finally {
    await stub.close()
  }
})

test('a caller abort wins over the deadline', async () => {
  const stub = await startStub({ delayMs: 300 })
  try {
    const controller = new AbortController()
    const pending = gatewayFor(stub.url, { timeoutMs: 5000 }).search('q', { signal: controller.signal })
    controller.abort()
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'aborted')
      return true
    })
  } finally {
    await stub.close()
  }
})

test('an unreachable host is a network error, not a crash', async () => {
  await assert.rejects(gatewayFor('http://127.0.0.1:1').search('q'), (error) => {
    assert.ok(error instanceof GatewayError)
    assert.equal(error.code, 'network')
    return true
  })
})

test('an empty API key is reported before any request', async () => {
  const gateway = gatewayFor('http://127.0.0.1:1', {}, {})
  await assert.rejects(gateway.search('q'), (error) => {
    assert.equal(error.code, 'unconfigured')
    assert.match(error.message, /STUB_KEY/)
    return true
  })
})

test('an empty space id is reported separately from a missing key', async () => {
  const gateway = new MemoryGateway(resolveConfig({ endpoint: 'http://127.0.0.1:1' }), { STUB_KEY: 'k' })
  await assert.rejects(gateway.search('q'), (error) => {
    assert.equal(error.code, 'unconfigured')
    assert.match(error.message, /spaceId/)
    return true
  })
})

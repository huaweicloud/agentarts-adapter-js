/**
 * End-to-end: the real plugin `apply()` against a local stub of the AgentArts
 * Memory data plane. No SDK, no network, no credentials — this runs anywhere.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { apply } from '../index.js'
import { resolveConfig } from '../src/config.js'

const RECORD = { id: 'mem-1', content: '用户偏好 TypeScript 做新项目', strategy_type: 'user_preference' }

/**
 * @param {{status?: number, body?: unknown}} [options]
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
        body: raw === '' ? undefined : JSON.parse(raw),
      })
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
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

/** Minimal Cordis-shaped context that records registrations. */
function makeCtx() {
  const log = { tools: [], listeners: [], sections: [], commands: [], effects: [] }
  const ctx = {
    on(name, handler) {
      log.listeners.push({ name, handler })
      return () => {}
    },
    effect(run) {
      const dispose = run()
      log.effects.push(dispose)
      return () => (typeof dispose === 'function' ? dispose() : undefined)
    },
    get(name) {
      if (name === 'systemPrompt') return { section: (section) => (log.sections.push(section), () => {}) }
      if (name === 'commands') return { register: (command) => (log.commands.push(command), () => {}) }
      return undefined
    },
    reflect: { get: () => undefined },
    tools: { register: (definition) => (log.tools.push(definition), () => {}) },
  }
  return { ctx, log }
}

const userMessage = (text) => ({ content: [{ type: 'text', text }] })

const CONFIGURED = (url, overrides = {}) => resolveConfig({
  enabled: true,
  spaceId: 'space-1',
  apiKeyEnv: 'STUB_MEMORY_KEY',
  endpoint: url,
  ...overrides,
})

test('the master switch registers nothing at all', () => {
  const { ctx, log } = makeCtx()
  apply(ctx, resolveConfig({ enabled: false, spaceId: 'space-1' }))
  assert.deepEqual(
    { tools: log.tools.length, listeners: log.listeners.length, sections: log.sections.length, commands: log.commands.length, effects: log.effects.length },
    { tools: 0, listeners: 0, sections: 0, commands: 0, effects: 0 },
  )
})

test('an unconfigured plugin stays mounted but offers no tools', () => {
  const { ctx, log } = makeCtx()
  apply(ctx, resolveConfig({ enabled: true }))
  assert.equal(log.tools.length, 0, 'no tool that cannot work')
  assert.equal(log.commands.length, 1, 'status command remains available')
  assert.deepEqual(log.listeners.map((listener) => listener.name), ['agent/pre-step'])
})

test('recall injects a memory returned by the stub data plane', async () => {
  process.env.STUB_MEMORY_KEY = 'stub-key'
  const stub = await startStub()
  try {
    const { ctx, log } = makeCtx()
    apply(ctx, CONFIGURED(stub.url, {
      recall: { enabled: true, minQueryChars: 1, minScore: 0.3, topK: 3 },
      tools: { enabled: true },
    }))

    const preStep = log.listeners.find((listener) => listener.name === 'agent/pre-step')
    assert.ok(preStep, 'pre-step listener must be registered')

    let nextCalls = 0
    const next = async () => {
      nextCalls += 1
      return { kind: 'enter', messages: 'NEXT' }
    }
    // One agent object across both calls: the dedupe map is keyed by identity.
    const agent = { id: 'agent-1' }

    const decision = await preStep.handler({ agent, messages: [userMessage('帮我写个 TypeScript 项目')] }, next)

    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 2, 'injected message plus the original one')
    const injected = decision.messages[0]
    assert.equal(injected.role, 'user')
    assert.equal(typeof injected.id, 'string')
    assert.ok(Object.isFrozen(injected))
    assert.match(injected.content[0].text, /AgentArts memory/)
    assert.match(injected.content[0].text, /TypeScript/)
    assert.match(injected.content[0].text, /0\.91/)

    assert.equal(stub.requests.length, 1)
    const [request] = stub.requests
    assert.equal(request.url, '/v1/core/spaces/space-1/memories/search')
    assert.equal(request.authorization, 'Bearer stub-key')
    assert.equal(request.body.query, '帮我写个 TypeScript 项目')
    assert.equal(request.body.top_k, 3)
    assert.equal(request.body.min_score, 0.3)

    // The same memory must not be injected twice within one agent's lifetime.
    const second = await preStep.handler({ agent, messages: [userMessage('再说一次 TypeScript 项目')] }, next)
    assert.equal(second.messages, 'NEXT', 'no re-injection for an already-seen memory')
  } finally {
    delete process.env.STUB_MEMORY_KEY
    await stub.close()
  }
})

test('recall degrades to next() when the data plane errors', async () => {
  process.env.STUB_MEMORY_KEY = 'stub-key'
  const stub = await startStub({ status: 500, body: { error_code: 'BOOM', error_msg: 'exploded' } })
  try {
    const { ctx, log } = makeCtx()
    apply(ctx, CONFIGURED(stub.url, { recall: { enabled: true, minQueryChars: 1 }, tools: { enabled: false } }))

    const preStep = log.listeners.find((listener) => listener.name === 'agent/pre-step')
    let nextCalls = 0
    const next = async () => {
      nextCalls += 1
      return { kind: 'enter', messages: 'NEXT' }
    }

    const decision = await preStep.handler({ agent: {}, messages: [userMessage('anything at all')] }, next)
    assert.equal(nextCalls, 1)
    assert.equal(decision.messages, 'NEXT')
  } finally {
    delete process.env.STUB_MEMORY_KEY
    await stub.close()
  }
})

test('recall short-circuits a query below minQueryChars without calling the cloud', async () => {
  process.env.STUB_MEMORY_KEY = 'stub-key'
  const stub = await startStub()
  try {
    const { ctx, log } = makeCtx()
    apply(ctx, CONFIGURED(stub.url, { recall: { enabled: true, minQueryChars: 50 }, tools: { enabled: false } }))

    const preStep = log.listeners.find((listener) => listener.name === 'agent/pre-step')
    await preStep.handler({ agent: {}, messages: [userMessage('short')] }, async () => ({ kind: 'enter', messages: 'NEXT' }))
    assert.equal(stub.requests.length, 0)
  } finally {
    delete process.env.STUB_MEMORY_KEY
    await stub.close()
  }
})

test('the tools are registered and render hits', async () => {
  process.env.STUB_MEMORY_KEY = 'stub-key'
  const stub = await startStub({ body: { records: [{ record: RECORD, score: 0.77 }] } })
  try {
    const { ctx, log } = makeCtx()
    apply(ctx, CONFIGURED(stub.url, { recall: { enabled: false }, tools: { enabled: true } }))

    assert.deepEqual(log.tools.map((tool) => tool.name), ['huawei_memory_search', 'huawei_memory_save'])

    const search = log.tools.find((tool) => tool.name === 'huawei_memory_search')
    const value = await search.execute({ query: 'typescript' })
    assert.equal(value.total, 1)
    assert.equal(value.results[0].content, RECORD.content)
    assert.equal(value.results[0].strategy_type, 'user_preference')

    // Official ToolDefinition contract: output.render returns content blocks.
    const blocks = search.output.render({ query: 'typescript' }, value)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /0\.77/)
  } finally {
    delete process.env.STUB_MEMORY_KEY
    await stub.close()
  }
})

test('tool schemas keep required arrays on object nodes only', () => {
  process.env.STUB_MEMORY_KEY = 'stub-key'
  try {
    const { ctx, log } = makeCtx()
    apply(ctx, CONFIGURED('http://127.0.0.1:1', { recall: { enabled: false }, tools: { enabled: true } }))
    assert.deepEqual(log.tools.map((tool) => tool.name), ['huawei_memory_search', 'huawei_memory_save'])

    const visit = (node, path) => {
      if (node.required !== undefined) {
        assert.equal(node.type, 'object', `${path}.required belongs on an object node`)
        assert.ok(Array.isArray(node.required), `${path}.required must be an array`)
      }
      for (const [name, child] of Object.entries(node.properties ?? {})) visit(child, `${path}.properties.${name}`)
      if (node.items !== undefined) visit(node.items, `${path}.items`)
    }
    for (const tool of log.tools) {
      visit(tool.parameters, `${tool.name}.parameters`)
      visit(tool.output.schema, `${tool.name}.output.schema`)
    }
  } finally {
    delete process.env.STUB_MEMORY_KEY
  }
})

test('the status command reports switches and endpoint', async () => {
  process.env.STUB_MEMORY_KEY = 'stub-key'
  const stub = await startStub()
  try {
    const { ctx, log } = makeCtx()
    apply(ctx, CONFIGURED(stub.url, { capture: { enabled: true } }))
    const status = await log.commands[0].handler({ rawInput: '' })
    assert.equal(status.kind, 'success')
    assert.match(status.text, /switches: plugin on · tools on · recall on · capture on/)
    assert.match(status.text, /status: ready/)
    assert.match(status.text, new RegExp(`endpoint: ${stub.url}`))
  } finally {
    delete process.env.STUB_MEMORY_KEY
    await stub.close()
  }
})

test('capture pushes turns when a session is disposed', async () => {
  process.env.STUB_MEMORY_KEY = 'stub-key'
  const stub = await startStub({ body: { messages: [{ id: 'a' }] } })
  try {
    const { ctx, log } = makeCtx()
    apply(ctx, CONFIGURED(stub.url, { recall: { enabled: false }, capture: { enabled: true }, tools: { enabled: false } }))

    const disposed = log.listeners.find((listener) => listener.name === 'session/disposed')
    assert.ok(disposed, 'capture must listen for session/disposed')

    const events = [
      { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你好，有什么可以帮你' }] } } },
    ]
    disposed.handler({
      id: 'session-1',
      firstLiveSeq: 0,
      snapshotEvents: () => events,
    })

    // The hook is fire-and-forget; wait for the two requests to land.
    for (let attempt = 0; attempt < 100 && stub.requests.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    assert.equal(stub.requests.length, 2)
    assert.equal(stub.requests[1].url, '/v1/core/spaces/space-1/sessions/session-1/messages')
    assert.deepEqual(stub.requests[1].body.messages, [
      { role: 'user', parts: [{ type: 'text', text: '你好' }], actor_id: 'dsh-user' },
      { role: 'assistant', parts: [{ type: 'text', text: '你好，有什么可以帮你' }], assistant_id: 'dsh' },
    ])
  } finally {
    delete process.env.STUB_MEMORY_KEY
    await stub.close()
  }
})

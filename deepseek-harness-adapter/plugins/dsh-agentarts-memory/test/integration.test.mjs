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

// Pass an empty env so an exported AGENTARTS_MEMORY_* on the developer's machine
// cannot leak into these assertions.
const CONFIGURED = (url, overrides = {}) => resolveConfig({
  enabled: true,
  spaceId: 'space-1',
  apiKeyEnv: 'STUB_MEMORY_KEY',
  endpoint: url,
  ...overrides,
}, {})

test('the master switch registers nothing at all', () => {
  const { ctx, log } = makeCtx()
  apply(ctx, resolveConfig({ enabled: false, spaceId: 'space-1' }, {}))
  assert.deepEqual(
    { tools: log.tools.length, listeners: log.listeners.length, sections: log.sections.length, commands: log.commands.length, effects: log.effects.length },
    { tools: 0, listeners: 0, sections: 0, commands: 0, effects: 0 },
  )
})

test('an unconfigured plugin stays mounted but offers no tools', () => {
  const { ctx, log } = makeCtx()
  apply(ctx, resolveConfig({ enabled: true }, {}))
  assert.equal(log.tools.length, 0, 'no tool that cannot work')
  assert.equal(log.commands.length, 1, 'status command remains available')
  // The default recall mode is `tool`: no pre-step listener is registered.
  assert.deepEqual(log.listeners.map((listener) => listener.name), [])
  assert.equal(log.sections.length, 0, 'no tool guidance without a ready space')
})

test('an environment-only deployment is ready and reaches the stub', async () => {
  process.env.STUB_MEMORY_KEY = 'stub-key'
  process.env.AGENTARTS_MEMORY_SPACE_ID = 'space-from-env'
  const stub = await startStub()
  process.env.AGENTARTS_MEMORY_DATA_ENDPOINT = stub.url
  try {
    const { ctx, log } = makeCtx()
    // No config at all beyond the apiKeyEnv: the hosted contract is env-only.
    apply(ctx, resolveConfig({ apiKeyEnv: 'STUB_MEMORY_KEY', recall: { enabled: false } }))

    const status = await log.commands[0].handler({ rawInput: '' })
    assert.match(status.text, /status: ready/)
    assert.match(status.text, /space-from-env/)

    const search = log.tools.find((tool) => tool.name === 'huawei_memory_search')
    assert.ok(search, 'tools are registered when env supplies space + key')
    await search.execute({ query: 'q' })
    assert.equal(stub.requests[0].url, '/v1/core/spaces/space-from-env/memories/search')
  } finally {
    delete process.env.STUB_MEMORY_KEY
    delete process.env.AGENTARTS_MEMORY_SPACE_ID
    delete process.env.AGENTARTS_MEMORY_DATA_ENDPOINT
    await stub.close()
  }
})

test('recall.mode tool skips injection but tells the agent the memory exists', () => {
  process.env.STUB_MEMORY_KEY = 'stub-key'
  try {
    const { ctx, log } = makeCtx()
    apply(ctx, CONFIGURED('http://127.0.0.1:1', { recall: { mode: 'tool' } }))

    assert.deepEqual(log.listeners.map((listener) => listener.name), [], 'no pre-step listener in tool mode')
    assert.deepEqual(log.tools.map((tool) => tool.name), ['huawei_memory_search', 'huawei_memory_save'])
    assert.equal(log.sections.length, 1)
    assert.match(log.sections[0].text, /cross-session long-term memory/)
    assert.match(log.sections[0].text, /huawei_memory_search/)
  } finally {
    delete process.env.STUB_MEMORY_KEY
  }
})

test('recall.mode off injects nothing and adds no memory hint', () => {
  process.env.STUB_MEMORY_KEY = 'stub-key'
  try {
    const { ctx, log } = makeCtx()
    apply(ctx, CONFIGURED('http://127.0.0.1:1', { recall: { mode: 'off' } }))

    assert.equal(log.listeners.length, 0, 'no pre-step listener in off mode')
    assert.equal(log.sections.length, 1, 'tool guidance is still registered')
    assert.doesNotMatch(log.sections[0].text, /cross-session long-term memory/)
  } finally {
    delete process.env.STUB_MEMORY_KEY
  }
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

test('the status command reports switches and endpoint', async () => {
  process.env.STUB_MEMORY_KEY = 'stub-key'
  const stub = await startStub()
  try {
    const { ctx, log } = makeCtx()
    apply(ctx, CONFIGURED(stub.url, { capture: { enabled: true } }))
    const status = await log.commands[0].handler({ rawInput: '' })
    assert.equal(status.kind, 'success')
    assert.match(status.text, /switches: plugin on · tools on · recall tool · capture on/)
    assert.match(status.text, /status: ready/)
    assert.match(status.text, new RegExp(`endpoint: ${stub.url}`))
    assert.match(status.text, /agentarts help/)
  } finally {
    delete process.env.STUB_MEMORY_KEY
    await stub.close()
  }
})

test('/agentarts help lists what the plugin does and what it does not', async () => {
  process.env.STUB_MEMORY_KEY = 'stub-key'
  try {
    const { ctx, log } = makeCtx()
    apply(ctx, CONFIGURED('http://127.0.0.1:1', { recall: { mode: 'tool' }, capture: { enabled: true } }))

    const help = await log.commands[0].handler({ rawInput: 'help' })
    assert.equal(help.kind, 'success')
    assert.match(help.text, /what this plugin can do/)
    assert.match(help.text, /huawei_memory_search/)
    assert.match(help.text, /agent tools \(on\)/)
    assert.match(help.text, /not provided/)
    assert.match(help.text, /recall tool/)
    assert.match(help.text, /capture on/)
    assert.match(help.text, /status: ready/)
  } finally {
    delete process.env.STUB_MEMORY_KEY
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

    disposed.handler({
      id: 'session-1',
      firstLiveSeq: 0,
      seq: 2,
      events: [
        { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你好，有什么可以帮你' }] } } },
      ],
    })

    // The hook is fire-and-forget; wait for the two requests to land.
    for (let attempt = 0; attempt < 100 && stub.requests.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    assert.equal(stub.requests.length, 2)
    assert.equal(stub.requests[1].url, '/v1/core/spaces/space-1/sessions/session-1/messages')
    assert.equal(stub.requests[1].body.idempotency_key, 'session-1:2')
    assert.deepEqual(stub.requests[1].body.messages, [
      { role: 'user', parts: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', parts: [{ type: 'text', text: '你好，有什么可以帮你' }] },
    ])
  } finally {
    delete process.env.STUB_MEMORY_KEY
    await stub.close()
  }
})

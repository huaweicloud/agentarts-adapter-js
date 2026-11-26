/**
 * The two explicit tools. Both are thin: argument coercion and rendering here,
 * all protocol work in {@link MemoryGateway}.
 *
 * Tool definitions are hand-written JSON Schema rather than `defineTool(...)`
 * from `@deepseek-ai/dsh-tools`, because this bundle intentionally imports no
 * `@deepseek-ai/*` package. `ctx.tools.register()` accepts a plain
 * `ToolDefinition`, and `defineTool` only compiles the compact spec into
 * exactly these JSON schemas.
 *
 * @module dsh-agentarts-memory/tools
 */

import { randomUUID } from 'node:crypto'

import { GatewayError } from './gateway.js'

/**
 * Register one resource whose disposer must run when the plugin unloads.
 *
 * `ctx.tools.register()` already hands back an exact disposer; owning it with
 * `ctx.effect` keeps teardown correct even though the tool layer is keyed on
 * the owning context rather than the caller.
 *
 * @param {object} ctx - Cordis plugin context
 * @param {() => (() => void)} register - performs the registration
 */
function own(ctx, register) {
  ctx.effect(() => {
    const dispose = register()
    return typeof dispose === 'function' ? dispose : () => {}
  }, 'agentarts memory registration')
}

/** Tool guidance appended to the system prompt when the tools are on. */
export const TOOLS_PROMPT = [
  'huawei_memory_search searches a shared cloud long-term memory (Huawei Cloud AgentArts) by meaning;',
  'huawei_memory_save queues one durable fact as short-term memory so the platform can extract it into the long-term memory asynchronously.',
  'Search before asking the user to repeat context. Save only durable facts the user would want remembered',
  '(preferences, project decisions, corrections) — never one-off requests, secrets or credentials.',
].join(' ')

/**
 * Turn a gateway failure into the message a tool call should fail with.
 *
 * @param {unknown} error - whatever the gateway threw
 * @returns {Error}
 */
export function toolFailure(error) {
  if (error instanceof GatewayError) {
    if (error.code === 'unconfigured') {
      return new Error(
        `AgentArts memory is not configured: ${error.message}. Export AGENTARTS_MEMORY_SPACE_ID and HUAWEICLOUD_SDK_MEMORY_API_KEY.`,
      )
    }
    return new Error(error.message)
  }
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * @param {object} ctx - Cordis plugin context
 * @param {import('./gateway.js').MemoryGateway} gateway - cloud gateway
 * @param {object} config - resolved configuration
 */
export function applyTools(ctx, gateway, config) {
  own(ctx, () => ctx.tools.register({
    name: 'huawei_memory_search',
    description:
      'Search the shared cloud long-term memory (Huawei Cloud AgentArts) by semantic similarity and return the best matching remembered facts with their scores.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Natural language query describing the context you need recalled.',
        },
        top_k: {
          type: 'integer',
          description: `Maximum results to return (default ${config.recall.topK}).`,
        },
        strategy_type: {
          type: 'string',
          description: 'Optional memory type filter: semantic, episodic, user_preference, summary, procedural.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['results', 'total'],
        properties: {
          total: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['score', 'content', 'strategy_type', 'id'],
              properties: {
                score: { type: 'number', required: true },
                content: { type: 'string', required: true },
                strategy_type: { type: 'string', required: true },
                id: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render(_args, value) {
        const hits = Array.isArray(value?.results) ? value.results : []
        if (hits.length === 0) return [{ type: 'text', text: 'No matching memory found.' }]
        const lines = hits.map((hit) => {
          const type = hit.strategy_type === '' ? 'memory' : hit.strategy_type
          return `- [${hit.score.toFixed(2)}] (${type}) ${hit.content}`
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const raw = args !== null && typeof args === 'object' ? args : {}
      const query = String(raw.query ?? '').trim()
      if (query === '') throw new Error('query must not be empty')
      const topK = Number.isInteger(raw.top_k) ? raw.top_k : undefined
      const strategyType = typeof raw.strategy_type === 'string' ? raw.strategy_type : undefined

      try {
        // Explicit searches are allowed the operator timeout: the short recall
        // deadline exists to protect an automatic step, not a call the model
        // (or the operator) decided to make.
        const hits = await gateway.search(query, { topK, strategyType, timeoutMs: config.timeoutMs })
        return {
          total: hits.length,
          results: hits.map((hit) => ({
            score: hit.score,
            content: hit.content,
            strategy_type: hit.strategyType,
            id: hit.id,
          })),
        }
      } catch (error) {
        throw toolFailure(error)
      }
    },
  }))

  own(ctx, () => ctx.tools.register({
    name: 'huawei_memory_save',
    description:
      'Queue one durable fact as short-term memory in this session. The memory platform extracts long-term memories from it according to the space strategies; extraction is asynchronous, so the fact may not be searchable immediately. Use for stable preferences, project decisions and corrections only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['content'],
      properties: {
        content: {
          type: 'string',
          description: 'The fact to remember, as one or two self-contained sentences.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['session_id', 'messages', 'content'],
        properties: {
          session_id: { type: 'string', required: true },
          messages: { type: 'integer', required: true },
          content: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [
          {
            type: 'text',
            text: `Queued for memory extraction in session ${value?.session_id ?? '(none)'} (${value?.messages ?? 0} message(s)): ${value?.content ?? ''}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      const raw = args !== null && typeof args === 'object' ? args : {}
      const content = String(raw.content ?? '').trim()
      if (content === '') throw new Error('content must not be empty')

      const sessionId = exec?.agent?.session?.id
      if (sessionId === undefined || String(sessionId) === '') {
        throw new Error('huawei_memory_save needs an active session')
      }

      try {
        // Short-term memory is the session message stream; the platform turns it
        // into long-term records. The idempotency key is per call so repeated
        // saves in one session are all accepted.
        const pushed = await gateway.pushMessages(String(sessionId), [{ role: 'user', content }], {
          idempotencyKey: `save-${randomUUID()}`,
        })
        return { session_id: String(sessionId), messages: pushed, content }
      } catch (error) {
        throw toolFailure(error)
      }
    },
  }))
}

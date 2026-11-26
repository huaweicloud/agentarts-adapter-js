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
  'huawei_memory_search searches the shared cloud long-term memory (Huawei Cloud AgentArts) by meaning;',
  'huawei_memory_save stores a fact as short-term memory for this session, and the platform extracts long-term memories from it automatically.',
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
          total: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['score', 'content', 'strategy_type', 'id'],
              properties: {
                score: { type: 'number' },
                content: { type: 'string' },
                strategy_type: { type: 'string' },
                id: { type: 'string' },
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
        const hits = await gateway.search(query, { topK, strategyType })
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
      'Save a fact as short-term memory for this session. The platform later extracts long-term memories from it automatically.',
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
        required: ['accepted'],
        properties: {
          accepted: { type: 'integer' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: `Saved to short-term memory (${value?.accepted ?? 0} message(s)); the platform will extract long-term memories from it.` }]
      },
    },
    async execute(args, exec) {
      const raw = args !== null && typeof args === 'object' ? args : {}
      const content = String(raw.content ?? '').trim()
      if (content === '') throw new Error('content must not be empty')
      const sessionId = exec?.agent?.session?.id
      if (sessionId === undefined || String(sessionId) === '') {
        throw new Error('short-term memory save requires an active session')
      }
      const key = `${String(sessionId)}:${Date.now()}`

      try {
        const accepted = await gateway.pushMessages(String(sessionId), [{ role: 'user', content }], key)
        return { accepted }
      } catch (error) {
        throw toolFailure(error)
      }
    },
  }))
}

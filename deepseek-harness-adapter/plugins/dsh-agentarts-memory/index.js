/**
 * dsh-agentarts-memory — Huawei Cloud AgentArts Memory for DeepSeek Harness.
 *
 * A dependency-free Host bundle with one row and four independent switches:
 *
 * | switch            | effect                                                   |
 * | ----------------- | -------------------------------------------------------- |
 * | `enabled`         | the whole plugin; `false` registers nothing at all        |
 * | `tools.enabled`   | the `huawei_memory_search` / `huawei_memory_save` tools   |
 * | `recall.mode`     | `auto` injects recall, `tool` leaves it to the model, `off` |
 * | `capture.enabled` | push a finished session's turns for platform extraction    |
 *
 * The plugin imports neither `@deepseek-ai/*` nor `@huaweicloud/agentarts-sdk`:
 * it carries its own data-plane client (`src/gateway.js`). That is what makes
 * installing this directory work with no build step and no extra setup — the
 * official SDK cannot be a dependency here because its `package.json` carries
 * a `workspace:*` agentidentity dependency, which pnpm refuses through `file:`.
 *
 * @module @laynepeng/dsh-agentarts-memory
 */

import { checkReady, describeSwitches, resolveConfig } from './src/config.js'
import { MemoryGateway } from './src/gateway.js'
import { applyTools, TOOLS_PROMPT } from './src/tools.js'
import { applyRecall } from './src/recall.js'
import { applyCapture } from './src/capture.js'
import { createLogger } from './src/log.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-agentarts-memory'

/** The tool registry is the one service this plugin cannot work without. */
export const inject = ['tools']

/** System-prompt section order for the tool guidance (tool guidance lives at 100–199). */
const PROMPT_ORDER = 106

/**
 * Extra prompt text for `recall.mode: tool`: the model cannot see the memory
 * contents, so it has to be told the capability exists, otherwise it rarely
 * calls the search tool (the usual "has a tool but never uses it" failure).
 */
const RECALL_TOOL_HINT = [
  'A cross-session long-term memory (Huawei Cloud AgentArts) is available through huawei_memory_search.',
  'When the user refers to an earlier decision, something from a previous session, or an existing convention, search it first.',
].join(' ')

/**
 * The prompt section text: tool guidance, plus the availability hint when
 * recall is model-driven.
 *
 * @param {object} config - resolved configuration
 * @returns {string}
 */
function toolSectionText(config) {
  return config.recall.mode === 'tool' ? `${RECALL_TOOL_HINT} ${TOOLS_PROMPT}` : TOOLS_PROMPT
}

/**
 * Register the plugin.
 *
 * @param {object} ctx - Cordis plugin context
 * @param {object} [rawConfig] - the row's `config` from the bundle patch
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  // The master switch: when off, nothing is registered and the session is
  // byte-for-byte identical to a profile without this plugin.
  if (!config.enabled) return

  const log = createLogger(ctx, name)
  const readiness = checkReady(config)
  if (!readiness.ok) {
    // Unconfigured is a normal state for a freshly installed plugin: stay
    // mounted, register nothing that can fail, and say why in the log.
    log.info(`inactive — ${readiness.reason}`)
  }

  const gateway = new MemoryGateway(config)
  ctx.effect(() => () => gateway.close(), `${name}: client`)

  if (config.tools.enabled && readiness.ok) {
    applyTools(ctx, gateway, config)
    // Read the prompt registry without declaring a hard dependency on it, and
    // own the section with `ctx.effect` so unloading the plugin removes it.
    const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
    if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
      ctx.effect(
        () =>
          systemPrompt.section({
            name: 'tool:agentarts_memory',
            order: PROMPT_ORDER,
            text: toolSectionText(config),
          }),
        `${name}: prompt section`,
      )
    }
  }

  // `tool` and `off` modes register no pre-step listener at all.
  if (config.recall.mode === 'auto') {
    applyRecall(ctx, gateway, config, readiness)
  }

  if (config.capture.enabled) {
    applyCapture(ctx, gateway, config, readiness, log)
  }

  applyStatusCommand(ctx, config, readiness, gateway)
}

/**
 * The `/agentarts` slash command: switch status, and an ad-hoc search so the
 * cloud memory can be inspected without going through the model.
 *
 * @param {object} ctx - Cordis plugin context
 * @param {object} config - resolved configuration
 * @param {{ok: boolean, reason?: string}} readiness - activation readiness
 * @param {MemoryGateway} gateway - cloud gateway
 */
function applyStatusCommand(ctx, config, readiness, gateway) {
  const reflect = ctx.reflect !== undefined && typeof ctx.reflect.get === 'function' ? ctx.reflect : undefined
  const commands =
    (reflect === undefined ? undefined : reflect.get('commands')) ??
    (typeof ctx.get === 'function' ? ctx.get('commands') : undefined)
  if (commands === undefined || typeof commands.register !== 'function') return

  const definition = {
    name: 'agentarts',
    description:
      'Show Huawei Cloud AgentArts memory status and capabilities, or "agentarts search <query>" to query it.',
    input: { hint: 'help | search <query>' },
    async handler(invocation) {
      const raw = String(invocation?.rawInput ?? '').trim()

      if (raw === 'help' || raw === 'capabilities') {
        return { kind: 'success', text: describeCapabilities(config, readiness) }
      }

      if (raw.startsWith('search ')) {
        const query = raw.slice('search '.length).trim()
        if (query === '') return { kind: 'error', text: 'usage: /agentarts search <query>' }
        try {
          const hits = await gateway.search(query, { topK: config.recall.topK })
          if (hits.length === 0) return { kind: 'success', text: 'no matching memory.' }
          const lines = hits.map((hit) => `- [${hit.score.toFixed(2)}] (${hit.strategyType || 'memory'}) ${hit.content}`)
          return { kind: 'success', text: lines.join('\n') }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      }

      const lines = [
        `switches: ${describeSwitches(config)}`,
        `space: ${config.spaceId === '' ? '(not set)' : config.spaceId} · region: ${config.region} · actor: ${config.actorId}`,
        `status: ${readiness.ok ? 'ready' : `inactive — ${readiness.reason ?? 'not configured'}`}`,
        `endpoint: ${gateway.baseUrl}`,
        'help: /agentarts help — what this plugin can and cannot do',
      ]
      return { kind: 'success', text: lines.join('\n') }
    },
  }

  ctx.effect(() => {
    const dispose = commands.register(definition)
    return typeof dispose === 'function' ? dispose : () => {}
  }, `${name}: command`)
}

/**
 * Capability matrix for `/agentarts help`: what runs automatically, what the
 * agent can call, what the operator can do, and what the plugin deliberately
 * does not do. Rendered from the current switches so it never claims a
 * capability that is turned off.
 *
 * @param {object} config - resolved configuration
 * @param {{ok: boolean, reason?: string}} readiness - activation readiness
 * @returns {string}
 */
function describeCapabilities(config, readiness) {
  const tools = config.tools.enabled ? 'on' : 'off'
  const capture = config.capture.enabled ? 'on' : 'off'

  const recallLines = {
    auto: [
      'automatic',
      "  · recall: before each turn's first step, search cloud memory with the user text and prepend the best hits with their scores",
      '  · the same memory is not injected twice within one agent session; hits below minScore or over the token budget are dropped',
    ],
    tool: [
      'automatic',
      '  · recall is model-driven: nothing is injected; the agent is told the memory exists and decides when to call huawei_memory_search',
    ],
    off: [
      'automatic',
      '  · recall is off: nothing is injected and the model gets no memory hint',
    ],
  }[config.recall.mode]

  return [
    'AgentArts memory — what this plugin can do',
    ...recallLines,
    '  · every cloud failure degrades silently (recall skips, capture logs a warning); a conversation is never blocked',
    `  · capture (${capture}): after a session ends, its dialogue turns are pushed for platform-side extraction`,
    '',
    `agent tools (${tools})`,
    '  · huawei_memory_search(query, top_k?, strategy_type?) — semantic search over the space',
    '  · huawei_memory_save(content, strategy_type?) — write one durable fact',
    '',
    'you can do',
    '  · /agentarts                 status: switches, space, region, actor, endpoint, readiness',
    '  · /agentarts search <query>  query cloud memory directly, without the model',
    '  · /agentarts help            this list',
    '',
    'not provided',
    '  · no citation back to the source events behind a memory',
    '  · no control over platform-side merge/dedup (that is the extraction strategy)',
    '  · no delete tool (the API supports it, it is not exposed)',
    '  · not a live data source: it stores distilled facts, not current data',
    '',
    `current: recall ${config.recall.mode} · tools ${tools} · capture ${capture} · status: ${readiness.ok ? 'ready' : `inactive — ${readiness.reason ?? 'not configured'}`}`,
  ].join('\n')
}

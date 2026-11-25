/**
 * dsh-agentarts-memory — Huawei Cloud AgentArts Memory for DeepSeek Harness.
 *
 * A dependency-free Host bundle with one row and four independent switches:
 *
 * | switch            | effect                                                   |
 * | ----------------- | -------------------------------------------------------- |
 * | `enabled`         | the whole plugin; `false` registers nothing at all        |
 * | `tools.enabled`   | the `huawei_memory_search` / `huawei_memory_save` tools   |
 * | `recall.enabled`  | automatic relevance-ranked recall on every agent step     |
 * | `capture.enabled` | push a finished session's turns for platform extraction    |
 *
 * The plugin imports neither `@deepseek-ai/*` nor `@huaweicloud/agentarts-sdk`:
 * it carries its own data-plane client (`src/gateway.js`). That is what makes a
 * `git` install usable with no build step and no extra setup — the official SDK
 * cannot be a dependency here because its `package.json` carries a
 * `workspace:*` agentidentity dependency, which pnpm refuses through `file:`.
 *
 * @module @agentarts/dsh-agentarts-memory
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
  // fetch uses no persistent agent here, so the gateway owns no resource to close.

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
            text: TOOLS_PROMPT,
          }),
        `${name}: prompt section`,
      )
    }
  }

  if (config.recall.enabled) {
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
    description: 'Show the Huawei Cloud AgentArts memory switches, or "agentarts search <query>" to query it.',
    input: { hint: 'search <query>' },
    async handler(invocation) {
      const raw = String(invocation?.rawInput ?? '').trim()

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
      ]
      return { kind: 'success', text: lines.join('\n') }
    },
  }

  ctx.effect(() => {
    const dispose = commands.register(definition)
    return typeof dispose === 'function' ? dispose : () => {}
  }, `${name}: command`)
}

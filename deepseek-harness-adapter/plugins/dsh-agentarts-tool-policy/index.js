/**
 * dsh-agentarts-tool-policy — enforce the AgentArts `allowed_tools` whitelist.
 *
 * The platform requests a tool whitelist through `agent_metadata.allowed_tools`,
 * using its own capability names (`read_file`, `write_file`, `edit_file`,
 * `list_files`, `glob`, `grep`, `bash`) plus the `*` wildcard. The Adapter forwards
 * the raw list into the DSH child environment as `AGENTARTS_ALLOWED_TOOLS`; this
 * bundle maps those names onto DSH tool names and applies a scoped
 * `ctx.tools.restrict({ allow })` at `agent/created`, so the model only sees (and
 * can only call) the permitted tools.
 *
 * `*` (or an empty list) leaves the agent unchanged: every tool is permitted.
 *
 * @module @agentarts/dsh-agentarts-tool-policy
 */

import { resolveAllowList } from './src/config.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-agentarts-tool-policy'

/** The tool registry is the one service this plugin cannot work without. */
export const inject = ['tools']

/**
 * @param {object} ctx - Cordis plugin context
 * @param {object} [rawConfig] - the row's `config` from the bundle patch
 */
export function apply(ctx, rawConfig) {
  const { wildcard, tools, unknown } = resolveAllowList(rawConfig)
  for (const capability of unknown) {
    console.warn(`[${name}] unknown AgentArts capability "${capability}" ignored`)
  }
  if (wildcard || tools.length === 0) return

  ctx.on('agent/created', ({ agent }) => {
    // All tool plugins are mounted by the time the first agent is created, so the
    // registry is complete here. Filter to names DSH actually registered: `bash`
    // vs `pwsh` is platform-conditional, and an unknown name must not reach
    // `tools.restrict` (it throws on unknown names).
    const known = new Set(ctx.tools.definitions().map((definition) => definition.name))
    const allow = tools.filter((tool) => known.has(tool))
    if (allow.length === 0) return
    // Scoped restriction: only this agent's visibility shrinks to the allow list.
    agent.ctx.tools.restrict({ allow })
  })
}
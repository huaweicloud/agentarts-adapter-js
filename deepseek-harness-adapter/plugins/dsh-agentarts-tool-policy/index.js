/**
 * dsh-agentarts-tool-policy — enforce the AgentArts `allowed_tools` whitelist.
 *
 * The platform requests a tool whitelist through `agent_metadata.allowed_tools`
 * using its own capability names (`read_file`, `write_file`, `edit_file`,
 * `list_files`, `glob`, `grep`, `bash`), plus the `*` wildcard. The Adapter
 * forwards the raw list into the DSH child environment as
 * `AGENTARTS_ALLOWED_TOOLS`; this bundle translates those names into DSH tool
 * names and applies a scoped `ctx.tools.restrict({ allow })` at `agent/created`.
 *
 * `allowed_tools` is a whitelist, so a configured list always restricts: every
 * global tool it does not name — after translation — is denied, **even when the
 * configured names translate to no registered tool**. Only an absent list or `*`
 * permits everything.
 *
 * Scoped registrations (per-session MCP tools, plugin-registered tools such as
 * the AgentArts memory tools) are outside `tools.restrict()`'s reach by design and
 * stay visible.
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
  const { specified, wildcard, tools, unknown } = resolveAllowList(rawConfig)
  // No whitelist configured, or `*`: leave the agent unchanged.
  if (!specified || wildcard) return

  for (const name of unknown) {
    console.warn(
      `[${name}] agent_metadata.allowed_tools entry "${name}" is not an AgentArts capability; it grants no tool`,
    )
  }

  ctx.on('agent/created', ({ agent }) => {
    // All tool plugins are mounted by the time the first agent is created, so the
    // registry is complete here. Filter to names DSH actually registered: `bash`
    // vs `pwsh` is platform-conditional, and an unknown name must not reach
    // `tools.restrict` (it throws on unknown names).
    const known = new Set(ctx.tools.definitions().map((definition) => definition.name))
    const allow = tools.filter((tool) => known.has(tool))
    // Whitelist semantics: an empty allow list denies every global tool.
    agent.ctx.tools.restrict({ allow })
  })
}
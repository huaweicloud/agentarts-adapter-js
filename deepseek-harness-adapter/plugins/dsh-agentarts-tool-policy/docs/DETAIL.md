# dsh-agentarts-tool-policy — detail

The bundle has no tools, no prompt sections and no persistent state. It registers
a single `agent/created` listener that translates the deployment whitelist into a
scoped tool restriction via `agent.ctx.tools.restrict({ allow })`.

DSH validates the names against the currently registered global tools: an unknown
name surfaces as a clear error instead of silently allowing the tool.
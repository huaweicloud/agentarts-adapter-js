# dsh-agentarts-tool-policy

Enforces the AgentArts `agent_metadata.allowed_tools` whitelist by applying a
scoped `ctx.tools.restrict({ allow })` to every agent at `agent/created`.

## How it works

1. The Adapter serializes `agent_metadata.allowed_tools` into the DSH child
   environment as `AGENTARTS_ALLOWED_TOOLS` (a JSON array of tool names).
2. This bundle reads that env (authoritative) or the `allow` config fallback.
3. On `agent/created`, it calls `agent.ctx.tools.restrict({ allow })`, so the
   model only sees — and can only call — the listed tools.

## Configuration

| Source | Meaning |
| --- | --- |
| `AGENTARTS_ALLOWED_TOOLS` | JSON array of tool names; wins over the config row |
| `config.allow` | fallback array for local runs without the environment |

An empty or missing list leaves the agent unchanged (no restriction).
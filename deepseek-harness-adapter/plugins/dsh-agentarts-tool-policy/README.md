# dsh-agentarts-tool-policy

Enforces the AgentArts `agent_metadata.allowed_tools` whitelist by applying a
scoped `ctx.tools.restrict({ allow })` to every agent at `agent/created`.

## How it works

1. The Adapter serializes `agent_metadata.allowed_tools` into the DSH child
   environment as `AGENTARTS_ALLOWED_TOOLS` (a JSON array of names).
2. This bundle reads that env (authoritative) or the `allow` config fallback.
3. It translates **AgentArts capability names** into DSH tool names, then calls
   `agent.ctx.tools.restrict({ allow })`, so the model only sees — and can only
   call — the translated tools.

## Capability mapping

| AgentArts name | DSH tool(s) |
| --- | --- |
| `bash` | `bash` (Linux) / `pwsh` (Windows) |
| `read_file` | `read` |
| `write_file` | `write` |
| `edit_file` | `edit` |
| `glob` | `glob` |
| `list_files` | `glob` (DSH lists files via `glob`) |
| `grep` | `grep` |

Names are matched against the live registry, so the platform-conditional
`bash`/`pwsh` pair resolves to whichever one is registered.

## Whitelist semantics

`allowed_tools` is a **whitelist**. The exact matrix:

| `allowed_tools` value | Behaviour |
| --- | --- |
| unset (or empty string) | no restriction — every tool permitted |
| `["*"]` | no restriction — every tool permitted |
| `[]` | deny every global tool |
| `["read_file","grep"]` | only the translated tools (`read`, `grep`) are permitted; every other global tool is denied |

Rules:

- Configured **without `*`** → every global tool the list does not name (after
  translation) is denied. A list that translates to nothing (`[]`, or only
  unknown names) denies every global tool; it never degrades to "no
  restriction".
- Only AgentArts capability names are recognised. A DSH tool name written
  verbatim (`read`, `read_image`, …) is not a whitelist entry: it grants
  nothing and is reported on stderr.

Scoped registrations — per-session MCP tools and plugin-registered tools such as
the AgentArts memory tools — are outside `tools.restrict()`'s reach by design and
stay visible even when the whitelist denies every global tool.

## Configuration

| Source | Meaning |
| --- | --- |
| `AGENTARTS_ALLOWED_TOOLS` | JSON array of AgentArts capability names; wins over the config row |
| `config.allow` | fallback array for local runs without the environment |
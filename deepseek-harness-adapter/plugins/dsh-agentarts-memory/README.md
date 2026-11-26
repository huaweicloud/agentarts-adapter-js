# AgentArts memory

Adds Huawei Cloud **AgentArts Memory** to DeepSeek Harness: a shared, cross-session
long-term memory behind a semantic search API. No npm dependencies, no build
step. Recall has three modes (automatic, model-driven, off) and defaults to
model-driven (`tool`): no injection, and the agent decides when to search, so
the blocking round trip only happens when it is actually needed.

## What it can do

| Capability | Switch | Behaviour |
| --- | --- | --- |
| Whole plugin | `enabled` | `false` registers nothing at all — identical to not having the plugin |
| Tools | `tools.enabled` | `huawei_memory_search` and `huawei_memory_save` |
| Recall | `recall.mode` | Default `tool`: inject nothing, but tell the agent the memory exists so it can decide. `auto`: also search before each turn's first step and prepend the best hits. `off`: no recall and no hint |
| Capture | `capture.enabled` | after a session ends, push its dialogue turns so the platform extracts memories |

`recall` and `capture` are best-effort by construction: every failure path returns
`next()` (recall) or logs a warning (capture), so a cloud outage cannot break a
conversation. Recall uses its own short deadline (`recall.timeoutMs`, default
1000ms) because it sits in front of the model; writes keep `timeoutMs` (5000ms).

## What it cannot do

- **No citation.** A recalled item is the platform's distilled summary; the
  original events behind it are not returned.
- **No control over merge/dedup.** That is the platform extraction strategy.
- **No delete tool.** The data plane supports deleting a memory, but it is not
  exposed as a model tool.
- **Not a live data source.** It recalls distilled facts, not current data.

Run `/agentarts help` in a session to see this list rendered with the current
switches.

## Requirements

A Huawei Cloud AgentArts **memory space** and its **data-plane API key**, both
supplied as environment variables to the process that runs DSH. This is the same
environment contract as the AgentArts memory toolkit (`agentarts-sdk`
`assets/toolkit/plugins/memory`), so one export configures the DSH plugin, the
MCP server and the hook scripts:

| Variable | Required | Meaning | Default |
| --- | --- | --- | --- |
| `HUAWEICLOUD_SDK_MEMORY_API_KEY` | ✅ | data-plane API key (Bearer auth) | — |
| `AGENTARTS_MEMORY_SPACE_ID` | ✅ | memory space id | — |
| `HUAWEICLOUD_SDK_REGION` | | region; also reads `HUAWEICLOUD_REGION`, `OS_REGION_NAME` | `cn-southwest-2` |
| `AGENTARTS_MEMORY_DATA_ENDPOINT` | | data-plane URL override | `https://memory.{region}.huaweicloud-agentarts.com` |
| `AGENTARTS_MEMORY_USER_ID` | ⚠️ | `actor_id`; **must equal the writer's actor id**, otherwise recall returns empty results with no error | `dsh-user` |
| `AGENTARTS_MEMORY_RERANK` | | search reranking: `1`/`true` on, `0`/`false` off | on |

`HUAWEICLOUD_SDK_AK` / `HUAWEICLOUD_SDK_SK` are **not** used: the data plane
authenticates with the API key only and does no request signing. No SDK
checkout, build step or npm dependency is needed — the data-plane client is part
of the plugin.

## Install

No build step: `index.js` is the entry. In this monorepo the plugin lives at
`deepseek-harness-adapter/plugins/dsh-agentarts-memory`; pick that directory in
`Plugins → Add plugin`.

Then export the space id and the API key in the environment of the process that
runs DSH:

```sh
export AGENTARTS_MEMORY_SPACE_ID="<space id>"
export HUAWEICLOUD_SDK_MEMORY_API_KEY="<data-plane api key>"
```

## Configure

Nothing in the bundle patch is needed for a normal deployment — export the
variables above and the plugin is ready. The row below only carries the
behaviour switches, plus optional fallbacks for local runs **without** the
environment variables (environment wins whenever it is set):

```yaml
- id: dsh-agentarts-memory
  name: '@laynepeng/dsh-agentarts-memory'
  config:
    enabled: true
    spaceId: ''                  # fallback only; prefer $AGENTARTS_MEMORY_SPACE_ID
    apiKeyEnv: HUAWEICLOUD_SDK_MEMORY_API_KEY
    region: ''                   # fallback only; prefer $HUAWEICLOUD_SDK_REGION
    endpoint: ''                 # fallback only; prefer $AGENTARTS_MEMORY_DATA_ENDPOINT
    actorId: ''                  # fallback only; prefer $AGENTARTS_MEMORY_USER_ID
    assistantId: dsh
    strategyId: ''               # leave empty unless your space requires one
    timeoutMs: 5000
    rerank: true                 # fallback; prefer $AGENTARTS_MEMORY_RERANK
    recall:
      mode: tool                 # auto | tool | off (legacy: enabled: true == auto, false == off)
      timeoutMs: 1000            # search deadline in front of the model
      topK: 5
      minScore: 0.35
      maxInjectTokens: 600
      cacheMs: 60000
      minQueryChars: 8
    tools:
      enabled: true
    capture:
      enabled: false
      maxMessages: 40
```

The simplest switch of all is the row's toggle in **Plugins** — that unmounts the
plugin without touching this page.

## In-session

```
/agentarts                 # switch status, space, readiness
/agentarts help            # what this plugin can and cannot do
/agentarts search 数据库    # ad-hoc semantic search
```

## Design notes

- **Injection happens on `agent/pre-step`, not in a system-prompt section.** A
  section provider is synchronous; AgentArts search is HTTP. `agent/pre-step` is
  the waterfall that may replace the messages entering a step.
- **Injected context is a frozen, identified user message.** The `enter` decision
  carries a complete message batch, so the message is built and frozen locally.
  Its `source.kind` is `user` because that is the union this DSH build declares;
  provenance is stated in the text instead.
- **Repeats are suppressed per agent.** A multi-step turn would otherwise inject
  the same memories at every step.
- **Only dialogue is captured.** Tool calls and tool results are dropped: shell
  output is exactly what should not be uploaded.
- **No metadata round-trip.** The AgentArts search response does not return a
  record's `metadata`, so recalled text is used as-is rather than mapped back to
  local state.
- **The wire format is transcribed, not imported.** `src/gateway.js` implements
  the five data-plane calls this plugin needs, with request shapes copied from
  the SDK sources (`parts: [{ type: 'text', text }]` for messages,
  `only_actived`/`rerank` on search). If the backend changes, that one file
  changes.

See `docs/DETAIL.md` for the API surface and the limitations this plugin does not
solve.

## Test

```sh
node --test "test/*.test.mjs"
```

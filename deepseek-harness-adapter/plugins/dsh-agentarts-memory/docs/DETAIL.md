# AgentArts memory — detail

## What it connects to

The plugin talks to the AgentArts Memory **data plane** through its own client
(`src/gateway.js`), a thin HTTPS client over these endpoints. The request shapes
are transcribed from the official SDK sources rather than imported, so the
plugin installs from the repository with no build step and no dependency:

| Purpose | Method + path |
| --- | --- |
| semantic search | `POST /v1/core/spaces/{space_id}/memories/search` |
| create a memory record | `POST /v1/core/spaces/{space_id}/memories` |
| delete a memory record | `DELETE /v1/core/spaces/{space_id}/memories/{memory_id}` |
| create a session | `POST /v1/core/spaces/{space_id}/sessions` |
| append messages | `POST /v1/core/spaces/{space_id}/sessions/{session_id}/messages` |

Authentication is `Authorization: Bearer <api key>`; no request signing is
involved on the data plane. The base URL resolves in this order: the `endpoint`
config, then `$AGENTARTS_MEMORY_DATA_ENDPOINT`, then
`https://memory.<region>.huaweicloud-agentarts.com`.

## Switch semantics

**`enabled: false`** — `apply()` returns before creating anything. No tools, no
event listeners, no command. This is the switch to use when you want the plugin
installed but completely out of the way.

**`tools.enabled`** — registers:

- `huawei_memory_search(query, top_k?, strategy_type?)` — semantic search, returns
  scored memory texts.
- `huawei_memory_save(content, strategy_type?)` — writes one memory record
  directly, bypassing server-side extraction. Defaults to `user_preference`.

Both tools also require a configured space and API key; without them the plugin
stays mounted but registers no tools, and the plugin log states why.

**`recall.enabled`** — on every `agent/pre-step` the incoming user text is used as
a search query (skipped below `minQueryChars`), the top hits above `minScore` are
rendered into one context block under `maxInjectTokens`, and that block is
prepended as an extra user message. Already-injected memory texts are remembered
per agent so a multi-step turn does not repeat itself. Searches are cached for
`cacheMs`.

**`capture.enabled`** (default `false`) — on `session/disposed` the dialogue turns
of the session are pushed with `is_force_extract: true`, using the DSH session id
both as the cloud session id and as the idempotency key. Tool calls and tool
results are not uploaded.

## Known limitations

- **Capture is opt-in and lossy.** It sends conversation text to a remote service
  and the extraction quality is the platform's; this plugin does not control it.
- **No citations back to the session log.** A recalled item is a cloud-side
  summary. Unlike a locally distilled memory it cannot be expanded to the exact
  source events.
- **No metadata round-trip.** `MemorySearchResponse` returns `content` and
  `score`; a record's `metadata` is not returned, so nothing is mapped back to
  local state.
- **`strategyId` may be required** by the backend when creating records directly.
  Leave it empty first; if the backend rejects the write, copy the strategy id
  from the memory space configuration into `strategyId`.
- **The recall injection path is not exercised without credentials.** Its pure
  helpers (query extraction, budget, rendering, message construction) are covered
  by unit tests; the live `agent/pre-step` round-trip needs a configured space.
- **The data-plane client is inlined.** If the backend changes a field name,
  `src/gateway.js` is the one place to update; there is no SDK version to pin.

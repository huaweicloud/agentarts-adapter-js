# AgentArts memory — detail

## What it connects to

The plugin talks to the AgentArts Memory **data plane** through its own client
(`src/gateway.js`), a thin HTTPS client over these endpoints. The request shapes
are transcribed from the official SDK sources rather than imported, so the
plugin installs from the repository with no build step and no dependency:

| Purpose | Method + path |
| --- | --- |
| semantic search | `POST /v1/core/spaces/{space_id}/memories/search` |
| delete a memory record | `DELETE /v1/core/spaces/{space_id}/memories/{memory_id}` |
| create a session | `POST /v1/core/spaces/{space_id}/sessions` |
| append messages | `POST /v1/core/spaces/{space_id}/sessions/{session_id}/messages` |

Authentication is `Authorization: Bearer <api key>`; no request signing is
involved on the data plane, so `HUAWEICLOUD_SDK_AK` / `HUAWEICLOUD_SDK_SK` are
not needed.

Deployment coordinates resolve from the **environment first**, then the bundle
patch row as a fallback: `AGENTARTS_MEMORY_SPACE_ID` (space),
`HUAWEICLOUD_SDK_REGION` → `HUAWEICLOUD_REGION` → `OS_REGION_NAME` (region,
default `cn-southwest-2`), `AGENTARTS_MEMORY_DATA_ENDPOINT` (base URL override,
default `https://memory.<region>.huaweicloud-agentarts.com`),
`AGENTARTS_MEMORY_USER_ID` (`actor_id`, default `dsh-user`) and
`AGENTARTS_MEMORY_RERANK` (search reranking, default on). These are the same
names the AgentArts memory toolkit uses, so one export configures every
integration.

`actor_id` is the recall filter that matters most: it **must equal the actor id
used when the memories were written**, otherwise search returns HTTP 200 with
zero records and no error. The default `dsh-user` is consistent for
recall + capture within this plugin, but a deployment that writes memory through
another integration has to export `AGENTARTS_MEMORY_USER_ID` to match it.

## Switch semantics

**`enabled: false`** — `apply()` returns before creating anything. No tools, no
event listeners, no command. This is the switch to use when you want the plugin
installed but completely out of the way.

**`tools.enabled`** — registers:

- `huawei_memory_search(query, top_k?, strategy_type?)` — semantic search, returns
  scored memory texts.
- `huawei_memory_save(content)` — adds one user message to the current session
  (short-term memory) with `is_force_extract: true`, so the platform's strategies
  extract the long-term record. Extraction is asynchronous, so the fact may not
  be searchable immediately. This path deliberately does not create a long-term
  record directly: merge/dedup policy belongs to the space strategies.

Both tools also require a configured space and API key; without them the plugin
stays mounted but registers no tools, and the plugin log states why.

**`recall.mode`** — three values:

- `tool` (default): no `agent/pre-step` listener is registered. The tool guidance
  gains one extra sentence telling the model the memory exists and when to query
  it; the model decides whether to pay for the round trip. Tools stay available.
- `auto`: on every `agent/pre-step` the incoming user text is used as a
  search query (skipped below `minQueryChars`), the top hits above `minScore` are
  rendered into one context block under `maxInjectTokens`, and that block is
  prepended as an extra user message. Already-injected memory texts are
  remembered per agent so a multi-step turn does not repeat itself. Searches are
  cached for `cacheMs`.
- `off`: neither injection nor hint; tools stay available if `tools.enabled` is
  true. The legacy boolean still works: `recall.enabled: true` maps to `auto` and
  `false` to `off`; with neither key set the mode is `tool`.

Recall uses `recall.timeoutMs` (default 1000ms) for the search request, because
it blocks the step that is about to call the model; `timeoutMs` (default 5000ms)
still governs writes and capture. Either failure path degrades silently.

**`capture.enabled`** (default `false`) — on `session/disposed` the dialogue turns
of the session are pushed with `is_force_extract: true`, using the DSH session id
both as the cloud session id and as the idempotency key. Tool calls and tool
results are not uploaded. Messages are the short-term store (`message_ttl_hours`,
7 days by default); long-term memory is always produced by platform extraction,
never written directly by this plugin.

## Known limitations

- **Capture is opt-in and lossy.** It sends conversation text to a remote service
  and the extraction quality is the platform's; this plugin does not control it.
- **No citations back to the session log.** A recalled item is a cloud-side
  summary. Unlike a locally distilled memory it cannot be expanded to the exact
  source events.
- **No metadata round-trip.** `MemorySearchResponse` returns `content` and
  `score`; a record's `metadata` is not returned, so nothing is mapped back to
  local state.
- **Saving is asynchronous.** `huawei_memory_save` writes short-term memory; the
  long-term record appears only after the platform extraction pass, so an
  immediate search may miss it.
- **The recall injection path is not exercised without credentials.** Its pure
  helpers (query extraction, budget, rendering, message construction) are covered
  by unit tests; the live `agent/pre-step` round-trip needs a configured space.
- **The data-plane client is inlined.** If the backend changes a field name,
  `src/gateway.js` is the one place to update; there is no SDK version to pin.

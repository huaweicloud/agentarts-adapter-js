# @agentarts/harness-dsh-runtime

Standalone TypeScript/pnpm/vitest runtime for `dsh acp` (DeepSeek Harness ACP).
It does not modify the adapter, shared or plugin packages.

Architecture doc: [`../docs/runtime-architecture.md`](../docs/runtime-architecture.md)
(layering, turn sequence, contracts, config reference, known issues).

## Features

- One `dsh acp` child process, multiple ACP sessions (in-memory reuse).
- `/invocations` SSE token streaming or `stream:false` JSON.
- ACP permission reverse requests with allow/reject/cancel/callback policy.
- AgentArts Gateway MCP targets: direct `mcpUrl` or `gatewayId + target`;
  API Key uses `Authorization: Bearer`; legacy SSE targets use the stdio bridge.
- Session-level system prompt: `append` / `replace` / `replace-all`, 256 KB.
- Session management actions: `list`, `close`, `cancel`, `set_config`.
- Session resume: pass `acpSessionId` (a `list` result, same `cwd`) to reattach a
  persisted DSH session; the resume response carries no id, so the request value
  is kept. Resume failures map to 409 (cwd mismatch / still active) or 404 (not
  resumable).
- Managed deployment metadata (`agent_metadata`): persona, model name/endpoint/key
  and gateway endpoint; an env var always wins over the metadata.
- Skills and session-store mounts: `skills-dir.patch.yml` and
  `sessions-dir.patch.yml` are applied by default (see below).
- Bounded turns: per-session queue timeout, prompt deadline that retires the
  stalled ACP session, and a 4 MB / 1024-event output budget.
- DSH child runs in a private temp cwd, so it never reads this package's `.env`
  (DSH rejects `DSH_*` in a project `.env`); the session workspace is passed
  through `session/new` separately. Its environment is an allow-list
  (`src/metadata.ts`), so platform credentials never reach the child.

## Layout

```
src/
├── main.ts                 CLI: .env, app, graceful shutdown
├── app.ts                  AgentArtsRuntimeApp + /invocations
├── invocation-handler.ts   SSE / JSON / management actions
├── runtime.ts              ACP sessions, prompt turns, token/permission routing
├── acp-client.ts           ACP v1 stdio JSON-RPC client
├── gateway.ts              AgentArts gateway target/auth/SSE bridge
├── permission.ts           approval policy + HTTP callback
├── prompt.ts               per-session system prompt store
├── config.ts               environment + managed metadata configuration
├── metadata.ts             agent_metadata parsing, child env allow-list
├── async-queue.ts          bounded event queue
├── errors.ts               RuntimeError/AcpError
└── types.ts                public types
plugins/
├── assistant-token-stream.mjs
├── assistant-token-stream.patch.yml
├── system-prompt-injector.mjs
├── system-prompt.patch.yml
├── skills-dir.patch.yml
├── sessions-dir.patch.yml
└── mcp-sse-bridge.mjs
```

## Configuration

`node dist/main.js` loads `.env` from the current directory (or
`DSH_ENV_FILE`); inherited process env wins. See `.env.example`.

Key variables: `DSH_ACP_COMMAND`, `DSH_ACP_ARGS`, `DSH_AGENT_CWD`,
`DSH_ACP_PERMISSION_MODE`, `DSH_ACP_APPROVAL_CALLBACK_URL`,
`DSH_AGENTARTS_GATEWAY_MCP_URL` / `GATEWAY_ID` + target,
`DSH_AGENTARTS_GATEWAY_API_KEY`, `DSH_SYSTEM_PROMPT`,
`DSH_SYSTEM_PROMPT_MODE`, `DSH_ACP_TOKEN_STREAM`, `AGENT_SERVER_PORT`
(`AGENT_SERVER_PORT`/`AGENT_SERVER_HOST` 兼容旧名 `PORT`/`AGENTARTS_BIND_IP`/`HOST`，旧名下个版本移除).

### Skills and session store mounts

`skills-dir.patch.yml` and `sessions-dir.patch.yml` are mounted with `--patch`
by default (unless `DSH_ACP_ARGS` is set explicitly) and evaluate `AGENTRUN_DIR`
inside the DSH loader. `AGENTRUN_DIR` is forwarded to the child through the
environment allow-list, so setting it here takes effect:

- skills: `skill-filesystem.customSkillDirs` = `<AGENTRUN_DIR>/skills`
  (falls back to `/home/agentarts/skills`). The patch restates
  `includeDefaultRoots: true` / `watch: false` because a loader patch replaces
  the row's whole `config`;
- sessions: `session-persistence-jsonl.root` = `<AGENTRUN_DIR>/sessions`
  (falls back to `/home/agentarts/sessions`). Any other deployment-specific
  fields of that row (`compression`, `listConcurrency`) belong in the same file.

## Build and test

```bash
pnpm --filter @agentarts/harness-dsh-runtime build
pnpm --filter @agentarts/harness-dsh-runtime test
pnpm --filter @agentarts/harness-dsh-runtime test:coverage
```

Tests use a fake ACP fixture (fault modes: hang, ignore-cancel, fail-prompt,
flood, malformed stdout) and cover token dedupe, SSE/JSON, management actions,
gateway auth/SSE routing, permission policy/callback, prompt modes and the
session queue/retirement paths. Line coverage is enforced at 80%.

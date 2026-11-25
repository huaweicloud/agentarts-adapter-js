# @agentarts/harness-dsh-runtime

DSH ACP execution runtime. The **adapter** package owns the upper protocol
surfaces (`/invocations` frame contract, `/ws`, A2A, AG-UI, round frames);
this package owns the persistent `dsh acp` process, sessions, token streaming,
approval, AgentArts gateway MCP and system-prompt injection.

## Architecture

```
adapter handlers (reused)
  /invocations  /ws  A2A  AG-UI
        │ Frame
        ▼
AcpScheduler ── RuntimeEvent ── AcpRuntime
                                  │
                                  ├─ SessionRegistry (in memory)
                                  ├─ GatewayResolver  (HTTP / SSE bridge)
                                  ├─ PermissionBroker (callback/policy)
                                  └─ SystemPromptStore (DSH plugin)
                                        │
                                        ▼
                                  dsh acp (isolated cwd)
```

- `/invocations` is implemented here and supports SSE token frames.
- `/ws`, A2A and AG-UI reuse `@agentarts/harness-dsh-adapter` handlers; they
  receive adapter `Frame`s projected from the ACP event stream.
- The runtime scheduler implements the adapter's structural
  `SchedulerLike` interface, so the upper handlers do not know about ACP.

## Source layout

```
src/
├── main.ts                 CLI: .env, app, graceful shutdown
├── app.ts                  AgentArts app + adapter protocol registration
├── invocation-handler.ts   /invocations SSE and stream:false JSON
├── scheduler.ts            RuntimeEvent → adapter Frame
├── runtime.ts              ACP sessions, prompt turns, token/permission routing
├── acp-client.ts           ACP v1 stdio JSON-RPC client
├── gateway.ts              AgentArts gateway target/auth/SSE bridge
├── permission.ts           approval policy + HTTP callback
├── prompt.ts               per-session system prompt store
├── config.ts               env resolution
├── async-queue.ts          event queue
├── errors.ts               RuntimeError/AcpError
└── types.ts                public types
plugins/
├── assistant-token-stream.mjs     DSH token stream plugin
├── system-prompt-injector.mjs     system-prompt/assemble waterfall
├── mcp-sse-bridge.mjs             legacy SSE MCP → stdio
└── *.patch.yml
```

## Features

- **ACP v1 over stdio**: one `dsh acp` child, multiple sessions.
- **Token streaming**: DSH plugin emits real provider deltas as ACP updates;
  committed chunks are deduplicated; final output uses DSH committed text.
- **SSE `/invocations`**: `session_ready`, `text_*`, `tool_call*`,
  `permission_*`, `usage`, `error`, `run_finished`.
- **Adapter frame protocol**: `session`, `delta`, `tool_call`, `tool_result`,
  `question`, final/error outcome.
- **Approval**: allow/reject/cancel/callback; callback body includes
  `requestId`, `sessionId`, `toolCall`, `options`.
- **Gateway**: direct `mcpUrl` or control-plane `gatewayId + target`; API Key
  uses `Authorization: Bearer`; legacy SSE target uses the stdio bridge.
- **System prompt**: `append` / `replace` / `replace-all` via a DSH
  `system-prompt/assemble` waterfall; per-session JSON file; 256 KB limit.
- **DSH env isolation**: the child runs in a private temp cwd so it does not
  read the adapter `.env` (DSH rejects `DSH_*` in project `.env`); session
  workspace/sandbox root is still passed through `session/new`.

## Configuration

`npm start` / `node dist/main.js` loads `.env` from the current directory (or
`DSH_ENV_FILE`); inherited process env wins. See `.env.example`.

Important variables:

| Variable | Meaning |
|---|---|
| `DSH_ACP_COMMAND` / `DSH_ACP_ARGS` | dsh command/args; defaults mount both plugins |
| `DSH_AGENT_CWD` / `DSH_ACP_CWD` | session workspace (not child process cwd) |
| `DSH_ACP_PERMISSION_MODE` | `allow` / `reject` / `cancel` / `callback` |
| `DSH_ACP_APPROVAL_CALLBACK_URL` | approval HTTP endpoint |
| `DSH_AGENTARTS_GATEWAY_MCP_URL` | direct gateway endpoint |
| `DSH_AGENTARTS_GATEWAY_ID` + `TARGET_ID`/`TARGET_NAME` | control-plane target |
| `DSH_AGENTARTS_GATEWAY_API_KEY` | API Key (`Authorization: Bearer`) |
| `DSH_SYSTEM_PROMPT` / `DSH_SYSTEM_PROMPT_MODE` | default system prompt |
| `DSH_ACP_TOKEN_STREAM` | enable token plugin |
| `DSH_ACP_MAX_CONCURRENCY` | app concurrency |
| `PORT` / `AGENTARTS_BIND_IP` | HTTP bind |

## Build and test

```bash
pnpm --filter @agentarts/harness-dsh-adapter build
pnpm --filter @agentarts/harness-dsh-runtime build
pnpm --filter @agentarts/harness-dsh-runtime test
```

The runtime tests use a fake ACP fixture and cover token dedupe, frame
projection, SSE, JSON, gateway auth/SSE routing and prompt limits.

## Limitations

- In-memory sessions only; no DSH `session/resume` mapping yet.
- MCP server list is fixed when the session is created.
- Permission `question` frames are emitted for adapter consumers, but the
  existing adapter frame protocol has no answer path; the runtime resolves via
  policy/HTTP callback.
- `replace-all` system prompt mode removes DSH's fixed identity/tool guidance.
- A2A/AG-UI registration is guarded until the SDK exposes those surfaces.

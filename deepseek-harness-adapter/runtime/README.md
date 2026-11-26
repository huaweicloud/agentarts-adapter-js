# @agentarts/harness-dsh-runtime

Standalone TypeScript/pnpm/vitest runtime for `dsh acp` (DeepSeek Harness ACP).
It does not modify the adapter, shared or plugin packages.

## Features

- One `dsh acp` child process, multiple ACP sessions (in-memory reuse).
- `/invocations` SSE token streaming or `stream:false` JSON.
- ACP permission reverse requests with allow/reject/cancel/callback policy.
- AgentArts Gateway MCP targets: direct `mcpUrl` or `gatewayId + target`;
  API Key uses `Authorization: Bearer`; legacy SSE targets use the stdio bridge.
- Session-level system prompt: `append` / `replace` / `replace-all`, 256 KB.
- Session management actions: `list`, `close`, `cancel`, `set_config`.
- DSH child runs in a private temp cwd, so it never reads this package's `.env`
  (DSH rejects `DSH_*` in a project `.env`); the session workspace is passed
  through `session/new` separately.

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
├── config.ts               environment configuration
├── async-queue.ts          event queue
├── errors.ts               RuntimeError/AcpError
└── types.ts                public types
plugins/
├── assistant-token-stream.mjs
├── assistant-token-stream.patch.yml
├── system-prompt-injector.mjs
├── system-prompt.patch.yml
└── mcp-sse-bridge.mjs
```

## Configuration

`node dist/main.js` loads `.env` from the current directory (or
`DSH_ENV_FILE`); inherited process env wins. See `.env.example`.

`AGENTRUN_DIR` sets the agent runtime root: the `dsh` child receives
`DSH_HOME=<AGENTRUN_DIR>/.dsh` (default `/home/agentarts/.dsh`), so profiles,
credentials and sessions live under that root instead of `~/.dsh`.

Key variables: `DSH_ACP_COMMAND`, `DSH_ACP_ARGS`, `DSH_AGENT_CWD`,
`DSH_ACP_PERMISSION_MODE`, `DSH_ACP_APPROVAL_CALLBACK_URL`,
`DSH_AGENTARTS_GATEWAY_MCP_URL` / `GATEWAY_ID` + target,
`DSH_AGENTARTS_GATEWAY_API_KEY`, `DSH_SYSTEM_PROMPT`,
`DSH_SYSTEM_PROMPT_MODE`, `DSH_ACP_TOKEN_STREAM`, `PORT`.

## Build and test

```bash
pnpm --filter @agentarts/harness-dsh-runtime build
pnpm --filter @agentarts/harness-dsh-runtime test
```

Tests use a fake ACP fixture and cover token dedupe, SSE/JSON, management
actions, gateway auth/SSE routing, permission policy/callback and prompt modes.

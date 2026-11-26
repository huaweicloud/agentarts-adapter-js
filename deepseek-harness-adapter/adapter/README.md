# AgentArts 托管 adapter

默认入口为 `node adapter/dist/main.js`。服务为 DSH 创建一个 ACP runtime，HTTP、WS、A2A 和 AG-UI 共享该实例。通用协议层依赖 `HarnessRunner`。接入其他 harness 时实现 `start`、`ready`、`runTurn` 和 `dispose`，并在启动入口选择对应实现。同一会话的执行顺序、事件流、最终结果和取消清理由 runner 保证。

## 启动和调用

使用项目支持的 Node 版本和 DSH CLI `0.2.2-rc.3`。

```sh
pnpm install --frozen-lockfile
pnpm run build
PORT=8080 node adapter/dist/main.js
```

- `GET /ping` 反映 ACP 握手、恢复和 SDK 容量状态。全局准入上限由 `AGENTRUN_MAX_CONCURRENCY` 设置，默认 15。WS 按在途轮次占用名额。
- `POST /invocations` 接受 `prompt`，默认返回 SSE；`stream:false` 返回含 `output` 和兼容字段 `result` 的 JSON。请求体的 `sessionId` 优先于 `x-hw-agentarts-session-id` 头。已知会话 ID 会在响应头回显。DSH 继续提供 list、close、cancel、set_config 管理动作。
- `/ws` 支持同一连接多轮。文本增量使用 `delta`，工具事件使用 `tool_call` 和 `tool_result`。成功时 `final.text` 是校正后的完整正文，失败时返回一条 `error`。连接断开会取消该连接的当前轮次。
- 排队期限由 `DSH_ACP_QUEUE_TIMEOUT_MS` 设置，默认 60 秒。执行期限由 `DSH_ACP_PROMPT_TIMEOUT_MS` 设置，默认 10 分钟。取消通知发出 5 秒后仍无回复时，runtime 尝试关闭对应 ACP 会话。关闭 RPC 使用 `DSH_ACP_REQUEST_TIMEOUT_MS`。无法确认关闭时隔离该会话，直到显式关闭成功或 ACP 进程更换。
- 每轮待拉取的事件缓冲最多 1024 条、4 MiB。输出超限后取消该轮并返回 `output_limit`。仅需 JSON 结果时跳过事件缓存。

## A2A 与 AG-UI

设置 `AGENTARTS_PROTOCOL_TOKEN` 启用两个 SDK 完整协议服务，token 至少 32 字节。沿用 SDK 本地示例，一个 token 代表一个部署身份。云上需由部署方提供认证与网关路由。

| 设置 | 用途 |
|---|---|
| `PORT`，默认 8080 | /ag-ui、/invocations、/ws、/ping 的监听端口 |
| `A2A_PORT`，默认 8001 | A2A JSON-RPC、REST 和 /.well-known/agent-card.json |
| `AGENTARTS_BIND_IP` | 监听地址。容器对外提供 A2A 时显式设为可达地址 |
| `AGENTARTS_PROTOCOL_PUBLIC_ORIGIN` | Agent Card 中公布的 A2A 地址。本地默认对应回环端口 |
| `AGENTARTS_PROTOCOL_STORAGE_DIR` | SDK 任务和线程存储目录，默认 .agentarts-protocol，每个目录由单一服务进程使用 |
| `AGENTARTS_PROTOCOL_STORAGE_KEY` | 可选的 64 位十六进制存储加密密钥 |
| `AGENTARTS_PROTOCOL_ORIGINS` | 浏览器跨域请求允许的来源，以逗号分隔 |

A2A 的会话使用认证身份与 contextId 定位。断开订阅后可查询或重新订阅任务，显式 CancelTask 会取消执行。AG-UI 使用认证身份与 threadId 定位会话，支持文本、工具调用和工具结果，断连会取消运行。两个入口目前接收文本输入。ACP 工具授权走 DSH permission 策略或回调。

## 平台重试和配置

HTTP 或 WS 携带 `eventId` 时，adapter 对同一 sessionId 和 eventId 做原子认领，`attempt` 记录尝试次数。已完成的相同输入重放最终结果，进行中或崩溃后结果未确定的事件返回 `event_pending`，相同键对应不同输入返回 `event_conflict`。HTTP 使用 409。重放只返回终态。设置 `AGENTARTS_EVENT_STORAGE_DIR` 将记录保存在该沙箱可持续访问的专用目录，默认 .agentarts-events。单一进程独占目录。存储容量和保留周期需要与平台的重试窗口匹配。

配置可由 `agent_metadata`、`AGENT_METADATA` 或 `AGENT_METADATA_FILE` 提供，支持 `system_prompt`、`model_config.name/base_url/api_key`、`mcp_gateway_config.endpoint`。显式 DSH 环境配置优先。模型、网关和系统提示仍可使用 runtime 配置。创建会话时解析 MCP 和网关设置，后续轮次复用已建立的 ACP 会话。请求改用另一网关目标时只使用本次请求提供的凭证。宿主协议 token 和召回凭证不会作为默认子进程环境传入 DSH。需要额外子进程环境时使用部署侧 `DSH_ACP_CHILD_ENV`。

memory_config、工具白名单和凭据提供方联调需使用实际平台样例。带有显式 allowed_tools 的部署会收到配置错误，以免启动后绕过工具策略。未解析的 credential_provider_name 需要先提供已解析的模型凭证。

## 验证

```sh
pnpm test
node scripts/smoke.mjs
node scripts/smoke-acp.mjs /path/to/@deepseek-ai/dsh/lib/bin.js
```

第一条烟测启动编译产物和模拟 ACP 子进程，经真实 HTTP/WS 验证 SDK 端点、重试和取消。第二条使用真实 DSH CLI、随包插件和回环模型服务，验证握手、模型选择、token、system prompt 注入及会话复用。

旧的每轮子进程路径可通过 `AGENT_RUNTIME_TYPE=DSH_HEADLESS` 显式选择，需要相应旧 profile。PI 和 CODEX 待提供对应 runner。

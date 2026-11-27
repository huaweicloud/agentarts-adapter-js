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
- 每轮待拉取的事件缓冲最多 1024 条、4 MiB。等待中的消费者可直接接收大事件。无法缓冲的单个大事件会被省略，SSE 在缓冲有空间时报告 `event_dropped`。持续积压达到上限时取消该轮并返回 `output_limit`。仅需 JSON 结果时跳过事件缓存。

## A2A 与 AG-UI

设置 `AGENTARTS_PROTOCOL_TOKEN` 启用两个 SDK 完整协议服务，token 至少 32 字节。沿用 SDK 本地示例，一个 token 代表一个部署身份。云上需由部署方提供认证与网关路由。

| 设置 | 用途 |
|---|---|
| `PORT`，默认 8080 | /ag-ui、/invocations、/ws、/ping 的监听端口 |
| `A2A_PORT`，默认 8001 | A2A JSON-RPC、REST 和 /.well-known/agent-card.json |
| `AGENT_SERVER_HOST` | 监听地址。容器对外提供 A2A 时显式设为可达地址 |
| `AGENTARTS_PROTOCOL_PUBLIC_ORIGIN` | Agent Card 中公布的 A2A 地址。本地默认对应回环端口 |
| `AGENTARTS_PROTOCOL_STORAGE_DIR` | SDK 任务和线程存储目录，默认 .agentarts-protocol，每个目录由单一服务进程使用 |
| `AGENTARTS_PROTOCOL_STORAGE_KEY` | 可选的 64 位十六进制存储加密密钥 |
| `AGENTARTS_PROTOCOL_ORIGINS` | 浏览器跨域请求允许的来源，以逗号分隔 |

A2A 的会话使用认证身份与 contextId 定位。断开订阅后可查询或重新订阅任务，显式 CancelTask 会取消执行。AG-UI 使用认证身份与 threadId 定位会话，支持文本、工具调用和工具结果，断连会取消运行。两个入口目前接收文本输入。ACP 工具授权走 DSH permission 策略或回调。

## 平台重试和配置

HTTP 或 WS 携带 `eventId` 时，adapter 对同一 sessionId 和 eventId 做原子认领。成功结果和不可重试失败会重放终态。已结算的 502、503、504（包括 runner 的结果 Promise 拒绝）只允许更高的 `attempt` 重新认领，同一次和更早的 attempt 重放已有终态。在途请求或崩溃后结果不确定的事件返回 `event_pending`，相同键对应不同输入返回 `event_conflict`。HTTP 使用 409。上层只应在可接受重做轮次时增加 attempt。设置 `AGENTARTS_EVENT_STORAGE_DIR` 将记录保存在持久化目录，默认 .agentarts-events。单一进程独占目录，存储保留周期需要覆盖平台的重试窗口。

配置可由 `agent_metadata`、`AGENT_METADATA`、`AGENT_METADATA_FILE` 或 `AGENTRUN_CONFIG_FILE` 提供，支持直接对象或 `agent_metadata` 包装。默认 ACP 入口读取模型、system prompt、多个 MCP gateway、记忆和技能配置，并通过 SDK Identity 解析缺失的模型、记忆和 MCP key。显式 `DSH_ACP_MODEL_PROVIDER` 会限定模型路由。默认优先匹配 ACP profile 提供的 `agentarts-model`。

创建会话时合并请求级 MCP、单网关配置和部署级 MCP。部署级 MCP 优先于同名请求配置，请求改用其他网关目标时使用请求自身凭据。子进程仅接收部署白名单和 `DSH_ACP_CHILD_ENV` 的显式覆盖，OBS 使用仅含 skills 和 user_bucket 的 metadata。`DSH_ACP_CHILD_ENV` 接受 JSON 对象中的字符串值，JSON 格式错误时启动会报告该变量名。

使用记忆和 OBS 技能前按 [ACP 集成说明](../docs/ACP-INTEGRATION.md) 生成部署 profile。`memory_config.memory_user_id` 可指定记忆 actor，`AGENTARTS_MEMORY_USER_ID` 可以覆盖它。`allowed_tools` 会经 `AGENTARTS_ALLOWED_TOOLS` 透传给 `dsh-agentarts-tool-policy` 插件，在 DSH 进程内以 `tools.restrict({ allow })` 强制执行工具白名单。

## 验证

```sh
pnpm test
node scripts/smoke.mjs
node scripts/smoke-acp.mjs /path/to/@deepseek-ai/dsh/lib/bin.js
```

第一条烟测启动编译产物和模拟 ACP 子进程，经真实 HTTP/WS 验证 SDK 端点、重试和取消。第二条使用真实 DSH CLI、随包插件和回环模型服务，验证握手、模型选择、token、system prompt 注入及会话复用。

旧的每轮子进程路径可通过 `AGENT_RUNTIME_TYPE=DSH_HEADLESS` 显式选择，需要相应旧 profile。PI 和 CODEX 待提供对应 runner。

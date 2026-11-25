# MCP 调用代码流程

本文按“一次 `/invocations` 请求”梳理 DSH ACP 适配层里的 MCP 代码路径：**请求解析 → 网关 target 解析 → ACP `session/new` 挂载 → 模型工具调用 → ACP 事件/审批 → 结果返回**。

> 适用版本：本项目 `dsh-acp-agentarts-runtime` + `@deepseek-ai/dsh` 0.2.2-rc.5。

---

## 0. 总览

```
POST /invocations
  │
  ▼
server.js handle()
  │ agent.plan()                    请求体 → plan（mcpServers/gateway/systemPrompt）
  ▼
DshAcpAgent.prepare()
  │
  ├─ system-prompt.js                systemPrompt → 会话文件（DSH 插件在进程内读取）
  ├─ GatewayMcpResolver.resolve()    gateway → ACP mcpServers 条目（HTTP 或 SSE bridge）
  │     └─ GatewayClient             getGateway / getGatewayTarget / listGatewayTargets
  ▼
SessionRegistry.open()
  │
  ▼
AcpClient.newSession()              ACP session/new { cwd, mcpServers }
  │
  ▼
dsh acp（子进程）
  │ dsh-acp: mountAcpMcpServers()
  │ dsh-mcp-client:
  │   stdio → spawn command
  │   http  → StreamableHTTPClientTransport
  │   initialize / notifications/initialized / tools/list
  ▼
模型看到 MCP 工具（命名空间 mcp__<server>__<tool>）
  │
  ▼
模型 tool_call
  │ dsh 工具执行器 → dsh-mcp-client → MCP server
  │ dsh-acp 投影 tool_call / tool_call_update
  ▼
AcpClient 通知 → PromptRun.pushUpdate → UpdateMapper → SSE 事件
```

---

## 1. 请求解析：plan 里有什么

入口：[`src/server.js`](../src/server.js) 的 `handle(payload, context)` 调用 [`src/agent.js`](../src/agent.js) 的 `plan()` → `parseInvocation()`。

它把请求体归一化成 plan，和 MCP 相关的字段：

| 请求字段 | plan 字段 | 处理 |
|---|---|---|
| `mcpServers` | `plan.mcpServers` | [`normalizeMcpServers()`](../src/gateway-mcp.js) 转成 **ACP v1 精确形状** |
| `gateway` | `plan.gateway` | [`normalizeGatewayConfig()`](../src/gateway-mcp.js) 合并实例默认值 |
| `systemPrompt` | `plan.systemPrompt` | 空字符串表示禁用实例默认值 |
| `cwd` / `sessionId` | `plan.cwd` / `plan.sessionKey` | 会话创建/复用用 |

### 1.1 `mcpServers` 归一化规则

`normalizeMcpServers()` 之后传给 ACP 的是：

- **stdio**（DSH 要求绝对命令、无 `type`）：
  ```json
  { "name": "local", "command": "/abs/node", "args": [], "env": [{ "name": "K", "value": "V" }] }
  ```
- **Streamable HTTP**（DSH 只支持这个 HTTP transport）：
  ```json
  { "name": "gw", "type": "http", "url": "https://.../mcp",
    "headers": [{ "name": "Authorization", "value": "Bearer ..." }] }
  ```
- `type: "sse"` 会被拒绝（`mcp_sse_unsupported`）；SSE 只能走下面的 bridge 形态。
- 同名 server 会被合并/覆盖；`args`、`env`、`headers` 都会转成 ACP 要求的数组形式。

---

## 2. 网关 target 解析：gateway → ACP mcpServers

入口：[`DshAcpAgent.prepare()`](../src/agent.js) 调用 [`GatewayMcpResolver.resolve()`](../src/gateway-mcp.js)。

### 2.1 两种来源

```
gateway.mcpUrl 有值 ──────────────► 直接用这个 URL
                                     │
gateway.gatewayId + targetId/name ──► GatewayClient.getGateway(id)          （取 authorizer 类型）
                                     → getGatewayTarget / listGatewayTargets
                                     → 摘要不足时再 getGatewayTarget(id) 取详情
                                     → extractGatewayTarget()
                                     → mcp_server.endpoint / url
```

### 2.2 解析出的 facts

`extractGatewayTarget()` 兼容 snake/camel、JSON 字符串、嵌套 endpoint：

```
target_configuration.mcp_server.endpoint
target_configuration.mcpServer.serverUrl
... .connection.url
... 等
```

随后：

1. **认证**：
   - `getGateway()` 返回 `authorizer_type`；
   - `api_key` 默认发 `Authorization: Bearer <API Key>`；
   - `custom_jwt` 用 `Authorization: Bearer <JWT>`；
   - `iam` 用 `X-HW-AgentGateway-Workload-Access-Token`（可换 `X-Auth-Token`）；
   - 支持从网关 `authorizer_configuration` 自动读取 API Key（显式 key 优先）。
2. **传输选择** `shouldUseSseBridge()`：
   - `transport = "sse"`，或 target `server_type` 含 `sse`，或 URL 路径以 `/sse` 结尾 → **stdio bridge**；
   - 其他（AgentArts 网关 `/mcp`）→ **Streamable HTTP**。
3. **生成 ACP 条目**：
   - HTTP：
     ```json
     { "name": "agentarts-gateway", "type": "http", "url": "...",
       "headers": [{ "name": "Authorization", "value": "Bearer ..." }] }
     ```
   - SSE bridge：
     ```json
     { "name": "agentarts-gateway",
       "command": "/abs/node",
       "args": [".../dsh-plugin/mcp-sse-bridge.mjs", "https://.../sse"],
       "env": [{ "name": "MCP_BRIDGE_HEADERS", "value": "{\"Authorization\":\"Bearer ...\"}" }] }
     ```
4. `mergeMcpServers()` 把它合并进 `plan.mcpServers`，然后交给 `SessionRegistry.open()`。

---

## 3. 会话创建：ACP `session/new` 如何挂 MCP

入口：[`SessionRegistry.open()`](../src/sessions.js) → `#createSession()`。

```
registry.open({ key, cwd, mcpServers, ... })
  │
  ├─ ensureCapacity / clientProvider()
  │     └─ DshAcpAgent.#ensureClient()
  │           ├─ AcpClient.start()      spawn: dsh --profile acp --patch <token plugin>
  │           └─ AcpClient.initialize() ACP initialize
  │
  ├─ try session/resume（可选）
  └─ AcpClient.newSession({ cwd, mcpServers })
        │
        ▼
     dsh-acp: mountAcpMcpServers()
        ├─ stdio: McpClient.Config({transport:"stdio", command,args,env,cwd})
        ├─ http : McpClient.Config({transport:"streamable-http", url,headers})
        └─ 校验失败 → session/new 失败（不会发布半成品 Agent）
        │
        ▼
     dsh-mcp-client 对每个 server：
        initialize → notifications/initialized → tools/list
```

### 3.1 两种 MCP server 形态在本项目里的来源

| 形态 | 来源 | 用途 |
|---|---|---|
| HTTP `type:"http"` | 网关 target / 请求 `mcpServers` | AgentArts 网关、普通 Streamable HTTP MCP |
| stdio（无 type） | SSE bridge / 请求 `mcpServers` | legacy SSE 转换、用户自定义 MCP |

> 系统提示词**不再**占用 MCP server：适配层写会话文件，DSH 插件注册 `systemPrompt.section`，见 §7.2。

### 3.2 会话落库

创建成功后 `entry.mcpServers` 保存实际挂载列表（含 bridge），后续同 `sessionId` 复用；新请求的 `mcpServers`/`gateway` **不会热插拔**。系统提示词文件可以随复用会话更新（下一次 assembly 生效）。
`session_ready` 里用 `describeMcpServers()` 只暴露 `name/type/url/headerNames/envNames`，不返回 header/env 值。

---

## 4. 一次 MCP 工具调用

入口：[`PromptRun.stream()`](../src/run.js)。

```
PromptRun.stream()
  ├─ AcpClient.prompt(sessionId, promptBlocks)       ACP session/prompt
  │
  ▼
dsh agent loop
  ├─ 组装 system prompt + tools + prompt
  ├─ 模型流式输出（token 插件发 session/update）
  └─ 模型返回 tool call
        │
        ▼
  dsh 工具执行器
        ├─ 权限策略可能先发 ACP reverse request:
        │    session/request_permission
        │
        ▼
  dsh-mcp-client.callTool(serverName, rawName, args)
        ├─ stdio bridge → 子进程 stdin
        ├─ http → Streamable HTTP POST tools/call
        └─ 上游 MCP server 返回 result
        │
        ▼
  工具结果回填模型；继续下一步/结束 turn
```

同时，DSH ACP 桥把工具生命周期投影成 ACP 通知：

```
session/update { sessionUpdate: "tool_call", ... }
session/update { sessionUpdate: "tool_call_update", status: "completed"|"failed", ... }
```

适配层接收路径：

```
AcpClient line reader
  → AcpClient.onNotification('session/update')
  → DshAcpAgent.#routeUpdate()
  → entry.currentRun.pushUpdate(update)
  → UpdateMapper.push(update)
  → SSE: tool_call / tool_call_update
```

---

## 5. 权限请求（reverse request）

```
dsh acp → AcpClient: { method:"session/request_permission", id, params }
  → DshAcpAgent.#routePermission()
  → PromptRun.handlePermission()
      ├─ 发 SSE permission_request（requestId/options/toolCall/expiresAt）
      ├─ PermissionBroker.decide()
      │    ├─ mode=allow/reject/cancel → 策略决定
      │    ├─ 进程内 hook
      │    └─ HTTP callback（POST 用户审批服务）
      └─ 发 SSE permission_resolved（decision/optionId/source）
  → AcpClient 写回 JSON-RPC result:
       { outcome: { outcome:"selected", optionId } }
       或 { outcome: { outcome:"cancelled" } }
```

> 必须应答，否则 DSH 工具会一直等；适配层在超时/取消时会回 `cancelled`。

---

## 6. SSE 事件收尾

```
PromptRun.stream()
  ├─ session_ready     会话/已挂载 MCP/系统提示词摘要
  ├─ run_started
  ├─ text_* / tool_call / tool_call_update / usage / permission_*
  ├─ run_finished      stopReason（end_turn/cancelled/...）
  └─ finally           取消未完成 turn、释放会话队列、临时会话 close
```

非流式 `stream:false` 时，`PromptRun.collect()` 消费同一事件流并折叠成 JSON（`toolCalls`/`permissions`/`mcpServers`/`gateway`/`systemPrompt`）。

---

## 7. 特殊组件的内部流程

### 7.1 SSE bridge（`dsh-plugin/mcp-sse-bridge.mjs`）

```
DSH MCP client ──stdio JSON-RPC──► bridge ──HTTP GET SSE──► 上游 SSE MCP
                     ▲                    │
                     │                    ├─ event: endpoint → POST 地址
                     └── SSE message ◄────┘   event: message  → stdout
```

- DSH 只看 stdio；
- bridge 负责 SSE 分帧、POST JSON-RPC、把 SSE `message` 写回 stdout；
- headers 从 `MCP_BRIDGE_HEADERS` 环境变量读取（不落命令行）。

### 7.2 系统提示词插件（`dsh-plugin/system-prompt-injector.mjs`）

```
PromptRun.stream()（已持有会话队列）
  → systemPrompts.write(acpSessionId, text, mode)
       $TMP/dsh-acp-system-prompts-*/<id>.json  { text, mode }
  → dsh acp 的 env DSH_SYSTEM_PROMPT_DIR 指向目录
  → ACP session/prompt
       → DSH system-prompt/assemble waterfall
            → 插件 prepend 监听，await next() 拿到全部贡献
            → 读 <id>.json，按 mode 修改 assembly.sections
                 append      persona 后追加
                 replace     替换 deployment:persona-prefix
                 replace-all 只保留自定义 section
  → finally 删除 <id>.json
```

- 不经过 MCP，没有 MCP instructions 标题与 32KB 限制；
- 每轮重写/读取，复用会话也能切换文本和模式；
- `append` 保留全局 persona；`replace` 保留 harness 身份/上下文/工具说明；`replace-all` 完全替换 system prompt sections。

---

## 8. 代码索引

| 阶段 | 文件 / 函数 |
|---|---|
| HTTP 入口 | `src/server.js` `handle()` |
| 请求解析 | `src/agent.js` `parseInvocation()` |
| 网关解析 | `src/gateway-mcp.js` `GatewayMcpResolver.resolve()` / `#resolveUncached()` / `#getTarget()` |
| MCP 归一化 | `src/gateway-mcp.js` `normalizeMcpServers()` / `normalizeMcpServer()` |
| 系统提示词 | `src/system-prompt.js` `SystemPromptStore` + `dsh-plugin/system-prompt-injector.mjs` |
| SSE bridge | `dsh-plugin/mcp-sse-bridge.mjs` |
| 会话创建 | `src/sessions.js` `open()` / `#createSession()` |
| ACP 客户端 | `src/acp-client.js` `newSession()` / `prompt()` / `onNotification()` / `onRequest()` |
| 单轮运行 | `src/run.js` `stream()` / `pushUpdate()` / `handlePermission()` |
| 事件映射 | `src/event-mapper.js` `UpdateMapper` |
| 权限决定 | `src/permission-broker.js` `PermissionBroker.decide()` |
| DSH 侧挂载 | `@deepseek-ai/dsh-acp` `mountAcpMcpServers()` / `resolveMcpConfigs()` |
| DSH MCP 工具 | `@deepseek-ai/dsh-mcp-client` |

---

## 9. 常见失败点

| 现象 | 所在阶段 | 排查 |
|---|---|---|
| `mcp_sse_unsupported` | 请求解析 | 请求里显式给了 `type:"sse"`；改用网关 HTTP endpoint 或让 gateway 自动 bridge |
| `gateway_target_endpoint_missing` | 网关解析 | target 摘要无配置；看 `data.shape`，或直接配 `gateway.mcpUrl` |
| `gateway_auth_required` / 401 | 网关认证 | 按 `authorizer_type` 配 `api_key`/JWT/token；AgentArts 网关 API Key 用 `Authorization: Bearer` |
| `session/new` 报 `mcp-client(...): initial connection or tool synchronization failed` | ACP 挂载 | endpoint 不可达、认证失败、transport 不符；看 `gateway`/`bridgeLog` |
| 模型看不到工具 | MCP 初始化 | `tools/list` 是否返回工具；gateway 是否只暴露 semantic search 工具 |
| 工具调用一直挂起 | 权限 | 是否漏应答 `session/request_permission`；看审批回调 |
| 工具名不是预期 | 命名 | DSH 命名为 `mcp__<serverName>__<rawName>`，serverName 是适配层给的 `name` |

# 实现总结：dsh-acp-agentarts-runtime

> 目标：把 `dsh acp`（DeepSeek Harness 的 ACP 模式）包装成标准 AgentArts Agent 服务，支持 token 流式输出、用户权限审批、会话复用/恢复、AgentArts 网关 MCP target，以及会话级系统提示词。

当前验证环境：Node.js 26.13.1、`@deepseek-ai/dsh` 0.2.2-rc.5、AgentArts SDK for Node.js。

---

## 1. 总体架构

```
AgentArts 客户端 / 平台
  │  POST /invocations（SSE 或 stream:false）
  ▼
AgentArtsRuntimeApp（@huaweicloud/agentarts-sdk）
  │
  ▼
DshAcpAgent
  ├─ parseInvocation()            请求 → plan
  ├─ prepare()
  │    ├─ GatewayMcpResolver      网关 target → ACP mcpServers（HTTP / SSE bridge）
  │    └─ SystemPromptStore       系统提示词 → 会话 JSON 文件
  ├─ SessionRegistry              key → ACP session；复用/恢复/排队/TTL
  └─ PromptRun                    单轮事件队列、token/提交对齐、审批应答
       │
       ▼
AcpClient（stdio NDJSON JSON-RPC 2.0）
       │
       ▼
dsh acp 子进程（隔离的临时 cwd）
  ├─ DSH agent loop → 模型
  ├─ dsh-mcp-client → AgentArts 网关 / 普通 MCP
  ├─ token-stream 插件（--patch）→ ACP token update
  └─ system-prompt 插件（--patch）→ system-prompt/assemble waterfall
```

关键取舍：

- **不改 DSH 源码/profile**：通过 `--patch` 挂两个随包插件；
- **一个 ACP 子进程承载多个会话**，避免每个 AgentArts 会话启动一个 DSH；
- **适配层只做协议翻译与编排**，会话账本仍由 DSH 持久化。

---

## 2. 请求生命周期

### 2.1 入口与 plan

`POST /invocations` → `server.js` → `DshAcpAgent.plan()` → `parseInvocation()`。

归一化内容：

- `prompt` / `messages` → ACP content blocks；
- `sessionId` / `acpSessionId` / `cwd` / `queueTimeoutMs` / `timeoutMs`；
- `mcpServers` → ACP 精确形状（stdio 或 `type:"http"`，显式 `sse` 拒绝）；
- `gateway` → 网关配置；
- `systemPrompt` / `systemPromptMode`；
- `permission`；
- `model` / `reasoningEffort` / `configOptions`。

### 2.2 prepare

- **网关**：`GatewayMcpResolver.resolve()` 解析出 `mcpServers` 条目和 `gateway` 摘要；
- **系统提示词**：只校验大小/模式，生成 `systemPrompt` 元数据；真正的文件在每轮 prompt 前写入；
- **合并 MCP**：按 name 去重/覆盖；
- **打开会话**：`SessionRegistry.open()`：
  - 内存有 → 复用；
  - 没有且可恢复 → `session/resume`；
  - 否则 → `session/new`，附带 `cwd` 和 `mcpServers`。

### 2.3 执行一轮

`PromptRun.stream()`：

1. 获取该会话的串行队列（同一 ACP 会话一次只允许一个 prompt）；
2. 写/删系统提示词文件；
3. 发 `session_ready`、`run_started`；
4. `AcpClient.prompt()` → DSH agent loop；
5. 消费 ACP 通知：
   - token/提交文本 → `text_*`；
   - 工具生命周期 → `tool_call` / `tool_call_update`；
   - 配置/用量/计划 → 对应事件；
   - 反向权限请求 → `permission_*`；
6. `run_finished`；
7. finally：取消未完成轮、删除系统提示词文件、释放队列、临时会话 close。

---

## 3. 核心能力

### 3.1 Token 级流式输出

DSH 标准 ACP 只在 assistant 消息提交后发整块 `agent_message_chunk`。适配层通过 `dsh-plugin/assistant-token-stream.mjs`：

- 监听 `agent/assistant-stream` 的正文/思考 delta；
- 直接写合法 ACP `session/update`，带 `_meta["dsh-acp/token"]`；
- DSH 的提交块仍会到；`PromptRun` 做去重与最终对齐：
  - token 文本是前缀/一致 → 抑制重复提交块；
  - 提交文本更长 → 补发后缀；
  - 两者分叉 → `text_correction` 让客户端替换；
- 插件未挂载/事件缺失 → 自动回退提交块模式，最终结果仍正确。

对应 `session_ready` 的 `acpSessionId`、`text_start/delta/end` 的 `token:true`、`text_correction`。

### 3.2 用户权限审批

DSH 在执行敏感工具前发 ACP 反向请求 `session/request_permission`。适配层：

- `AcpClient.onRequest` → `DshAcpAgent.#routePermission` → `PromptRun.handlePermission`；
- 发 `permission_request` SSE；
- `PermissionBroker.decide()`：
  - `allow` / `reject` / `cancel` 策略；
  - 进程内 hook；
  - HTTP 审批回调（用户服务）；
  - 超时/取消 → fallback（默认 `cancelled`）；
- 写回 `{outcome:{outcome:"selected",optionId}}` 或 `cancelled`；
- 发 `permission_resolved`。

### 3.3 会话、并发与生命周期

- AgentArts 会话键 → 一个 ACP session；
- 内存复用、`session/resume` 冷恢复（cwd 必须一致）；
- 无会话键 → 临时会话，结束后关闭；
- 同会话串行队列，超时 409 `session_busy`；
- 不同会话并行；进程级 `DSH_ACP_MAX_RUNS`；
- TTL 回收、最大会话数、最久未用淘汰；
- 子进程崩溃后下次请求自动重启，内存会话失效，可 list + resume。

### 3.4 MCP：请求内 MCP + AgentArts 网关

**请求内 `mcpServers`**：

- stdio：绝对 `command`、`args`、`env`；
- Streamable HTTP：`type:"http"`、`url`、`headers`；
- 显式 `type:"sse"` 拒绝；SSE 只能由网关解析自动 bridge。

**网关 target**：

- 直连 `gateway.mcpUrl`，或控制面 `gatewayId` + `targetId/name`；
- `GatewayClient.getGateway()` 读 authorizer；
- `getGatewayTarget` / `listGatewayTargets`，摘要缺 endpoint 时再取详情；
- endpoint 兼容 snake/camel/JSON 字符串/嵌套字段；
- 传输选择：
  - `/mcp` / Streamable HTTP → `type:"http"`；
  - target `sse` / `/sse` / `transport:"sse"` → `dsh-plugin/mcp-sse-bridge.mjs`（stdio 桥）；
- 认证：
  - `api_key`：默认 **`Authorization: Bearer <API Key>`**（按 AgentArts 官方示例）；
  - `custom_jwt`：Bearer JWT；
  - `iam`：`X-HW-AgentGateway-Workload-Access-Token`（可换 `X-Auth-Token`）；
  - 运行时把 `/invocations` 的 workload token / user id 透传给网关；
  - 可自动读取网关 authorizer 配置中的 API Key；
- 缓存 target 解析结果；错误带脱敏的 `gateway`、`bridgeLog`；
- 会话创建时固定 MCP 列表，复用会话不会热插拔。

### 3.5 系统提示词：append / replace / replace-all

实现从“MCP instructions”升级为 **DSH 进程内 `system-prompt/assemble` waterfall**：

- 适配层每轮写 `<acpSessionId>.json`：`{ text, mode }` 到私有临时目录；
- 插件 `dsh-plugin/system-prompt-injector.mjs` 以 `prepend:true` 监听 waterfall：
  - `await next()` 拿全部贡献；
  - `append`：persona 后追加；
  - `replace`：替换 `deployment:persona-prefix`；
  - `replace-all`：只保留自定义 section，仅保留 required 运行时上下文；
- `text` 来自文件，`interpolate:false`；
- 每轮重写，复用会话可切文本/模式；
- 上限 256 KB；非法模式 400；
- 不再是 MCP：无 `### MCP server` 标题、无 32KB MCP 限制、无额外进程。

### 3.6 配置：`.env` 与 DSH 子进程隔离

- `src/env.js`：零依赖 `.env` 解析/加载；
- `src/main.js` 启动时 `loadDotEnv()`：
  - 默认当前目录 `.env`，可用 `DSH_ENV_FILE`；
  - **进程环境优先**；
- `.env.example` 完整模板；`.env` gitignored；
- **DSH 子进程固定从私有临时目录启动**：
  - DSH 会读取进程 cwd 的 `.env`，并拒绝其中的 `DSH_*`（bootstrap-only）；
  - 适配层 `.env` 在项目目录，不能直接作为 DSH 的项目 env；
  - 隔离后 DSH 不读适配层 `.env`，但继承父进程已加载的环境变量；
  - 会话 cwd/沙箱根仍是 `DSH_AGENT_CWD` / `DSH_ACP_CWD` / 请求 cwd；
  - 子进程退出后清理临时目录。

---

## 4. 请求/事件契约（摘要）

请求关键字段：

- `action`：`prompt` / `list` / `close` / `cancel` / `set_config`；
- `prompt`、`messages`、`sessionId`、`acpSessionId`、`cwd`、`mcpServers`、`gateway`；
- `systemPrompt`、`systemPromptMode`；
- `permission`、`stream`、`timeoutMs`、`queueTimeoutMs`；
- `model`、`reasoningEffort`、`configOptions`。

SSE 事件：

- `session_ready`、`run_started`；
- `text_start` / `text_delta` / `text_end` / `text_correction` / `content`；
- `tool_call` / `tool_call_update`；
- `permission_request` / `permission_resolved`；
- `usage`、`config_option_update`、`session_info`、`plan` 等；
- `error`；
- `run_finished`。

非流式 `stream:false` 折叠为 JSON：`output`、`thought`、`stopReason`、`toolCalls`、`permissions`、`usage`、`mcpServers`、`gateway`、`systemPrompt` 等。

错误码示例：

- 400 `invalid_request` / `invalid_system_prompt_mode` / `system_prompt_too_large`；
- 401 `gateway_auth_required`；
- 404 `gateway_target_not_found`；
- 409 `gateway_target_ambiguous` / `session_busy` / `session_cwd_mismatch`；
- 502 `gateway_mcp_mount_failed` / `acp_error`；
- 503 `service_busy` / `shutting_down`。

---

## 5. 测试与验证

自动测试 **74/74**：

| 范围 | 数量 |
|---|---:|
| ACP 客户端 | 5 |
| 权限 broker | 9 |
| 协议/错误 | 2 |
| 配置 | 5 |
| `.env` | 3 |
| token 插件 | 3 |
| 网关解析/认证 | 16 |
| SSE bridge | 1 |
| 系统提示词 | 3 |
| 端到端（fake ACP） | 27 |

真实 `dsh acp`（0.2.2-rc.5）验证：

- `session/new` 成功；token 插件输出实际 token 增量；
- SSE bridge 与 HTTP MCP mock 均能完成 `initialize` / `tools/list`；
- 系统提示词三种模式在真实 `system-prompt/assemble` 结果中验证（append 保留 persona、replace 移除 persona、replace-all 仅自定义 section）；
- `.env` 加载 + DSH 子进程隔离后，`POST /invocations` 正常完成，不再触发 DSH bootstrap-only 报错。

> 网关认证按官方文档实现为 `Authorization: Bearer <API Key>`；实际云端请求是否成功仍取决于该网关 authorizer 的有效 key。

---

## 6. 安全与运维

- `.env` 已 gitignore；只提交 `.env.example`；
- 旧版本曾把部分凭证写在 `src/main.js`，应轮换 `HUAWEICLOUD_SDK_AK/SK`、`DEEPSEEK_API_KEY`、网关 API Key；
- 审批回调可配置 header；不要把回调服务暴露为无鉴权公网接口；
- MCP 网关 API Key 应来自网关详情 → Agent Identity 页面，不是控制面 AK/SK 或模型 Key；
- 系统提示词文件在私有临时目录（0600），每轮/退出清理；
- DSH 子进程使用隔离 cwd，不读取适配层 `.env`。

---

## 7. 已知限制

1. **一个 ACP 子进程**承载所有会话；子进程崩溃会使内存会话全部失效。
2. **MCP server 列表在会话创建时固定**；同一 session 不能热插拔网关/target。
3. **Gateway IAM 签名**不支持：DSH MCP client 不会逐请求做华为云 IAM 签名；需要 api_key/JWT 或签名代理。
4. **token 流依赖 DSH 插件**：DSH 升级若移除 `agent/assistant-stream`，会回退提交块（结果仍正确）。
5. **系统提示词 `replace-all` 会移除 DSH 固定身份/工具说明**，只在完全自控部署使用。
6. **示例脚本不自动加载 `.env`**；用 `node --env-file=.env ...` 或 export。
7. **显式 `acpArgs`** 不再自动注入 patch，需要自行包含 token/system-prompt patch。
8. **网关 authorizer api_key 的验证** 依赖有效 key；控制面只负责解析 target，不等于网关鉴权通过。

---

## 8. 关键文件

| 文件 | 作用 |
|---|---|
| `adapter/src/main.ts` | 容器主进程：app 装配、HTTP 启停、SIGINT/SIGTERM；启动 ACP 后端 |
| `runtime/src/index.ts` | ACP 后端库（`AcpRuntime`/`AcpScheduler`/`loadConfig`），无独立入口 |
| `src/agent.js` | 请求 plan、prepare、反向请求路由、子进程/隔离 cwd |
| `src/run.js` | 单轮事件、token/提交对齐、审批、超时/取消 |
| `src/sessions.js` | 会话复用/恢复/排队/TTL/关闭 |
| `src/acp-client.js` | ACP stdio 客户端、NDJSON、生命周期 |
| `src/gateway-mcp.js` | 网关 target 解析、认证、HTTP/SSE 选择、MCP 归一化 |
| `src/system-prompt.js` | 系统提示词存储、模式校验 |
| `src/env.js` | 零依赖 `.env` 加载 |
| `src/config.js` | 环境变量/参数归一化 |
| `src/permission-broker.js` | 权限策略/回调/hook |
| `dsh-plugin/assistant-token-stream.mjs` | token → ACP update |
| `dsh-plugin/mcp-sse-bridge.mjs` | legacy SSE MCP → stdio |
| `dsh-plugin/system-prompt-injector.mjs` | system-prompt waterfall 注入 |
| `.env.example` | 全部配置模板 |
| `docs/mcp-call-flow.md` | MCP 调用链路细节 |

---

## 9. 快速启动

```bash
cp .env.example .env
# 填 DEEPSEEK_API_KEY；需要网关/华为云时再填相应值
npm start
```

```bash
curl -N -X POST http://127.0.0.1:8080/invocations \
  -H 'content-type: application/json' \
  -H 'x-hw-agentarts-session-id: s-001' \
  -d '{"prompt":"你好","permission":{"mode":"allow"}}'
```

系统提示词：

```jsonc
{
  "prompt": "检查这个仓库",
  "systemPrompt": "你是一名只读代码审查员。",
  "systemPromptMode": "replace",
  "sessionId": "review-1"
}
```

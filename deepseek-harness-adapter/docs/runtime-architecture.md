# runtime 包架构说明（`@agentarts/harness-dsh-runtime`）

> **范围**：`runtime/` 目录（TypeScript 源码 `runtime/src`、DSH 插件 `runtime/plugins`、测试 `runtime/test`）。
> **基线**：当前工作区代码（含未提交改动：`skills-dir.patch.yml`、`sessions-dir.patch.yml`、`src/metadata.ts` 与 `config.ts` 的托管配置改造）。
> **验证**：`pnpm --filter @agentarts/harness-dsh-runtime test` → 10 个测试文件 / 74 个用例通过；`test:coverage` 行覆盖 84.06%（阈值 80%）。
> **代码规模**：`src/` 14 个模块共 2570 行；测试 10 个文件共 1138 行 + 1 个 ACP 假进程夹具；插件 3 个 `.mjs` + 4 个 `.patch.yml`。
> **行号提示**：代码仍在演进，文中 `file:line` 为写作时行号，可能漂移；定位请以函数/类名（符号）为准。

---

## 1. 定位：runtime 在仓库中的位置

仓库是 pnpm workspace（`pnpm-workspace.yaml`：`shared` / `adapter` / `runtime`），runtime 是**面向 DeepSeek Harness（DSH）的 ACP 运行时**：把「一次 AgentArts `/invocations` 调用」翻译成「ACP 协议上的一个 prompt 回合」，并复用一条长驻的 `dsh acp` 子进程。

它既可以作为库被 `adapter` 引用，也能独立启动（`node dist/main.js`），并且**不修改** `adapter` / `shared` / `plugins` 任何代码（`runtime/README.md` 明确约束）。

### 1.1 三个包的职责

| 包 | 目录 | 职责 | 与 runtime 的关系 |
| --- | --- | --- | --- |
| `@agentarts/harness-dsh-shared` | `shared/` | 跨 harness 的公共契约：NDJSON `Frame` 类型、`LaunchSpec`、`RoundRequest`、env 变量名 | runtime **不依赖** shared |
| `@agentarts/harness-dsh-adapter` | `adapter/` | 容器主进程：`Scheduler` + 每轮子进程 + `/invocations`、`/ws`、A2A、AG-UI 协议面 | 依赖 runtime（`workspace:*`），在 `adapter/src/main.ts:37` 按 `AGENT_RUNTIME_TYPE` 分叉 |
| `@agentarts/harness-dsh-runtime` | `runtime/`（本文档） | ACP 直连运行时：单子进程、多会话复用、SSE/JSON `/invocations`、权限反请求、系统提示词、Gateway MCP | 本文档主体 |
| 插件 | `plugins/` | 独立 DSH 插件（如 `dsh-agentarts-memory`） | 与 runtime 无编译期耦合；runtime 只挂载 `runtime/plugins` 下的自有插件 |

### 1.2 两条并存的执行链路

```
                       ┌─────────────────────────────────────────────┐
  容器入口             │ adapter/src/main.ts                          │
  node adapter/dist/…  │   config = loadConfig()  ← runtime 包        │
                       │   AGENT_RUNTIME_TYPE === 'DSH' ?            │
                       └───────────┬─────────────────────┬───────────┘
                                   │ 是（默认）           │ 否（PI / CODEX）
                                   ▼                     ▼
        ┌──────────────────────────────────┐   ┌──────────────────────────────┐
        │ 链路 A：runtime ACP 直连（默认）  │   │ 链路 B：Scheduler + Frame    │
        │ createDshApp(config)             │   │ createDefaultApp(config)     │
        │  → AgentArtsRuntimeApp           │   │  → Scheduler                 │
        │  → AcpRuntime                    │   │  → 每轮 spawn dsh --profile  │
        │  → 1 个长驻 dsh acp 子进程        │   │     agentrun -（一回合一进程）│
        │  → ACP 事件直接投影为 SSE         │   │  → 子进程 stdout NDJSON Frame │
        └──────────────────────────────────┘   └──────────────────────────────┘
```

链路 A 是本包；链路 B 是 adapter 的历史设计（`shared/src/frames.ts` 的 `Frame` 词汇表 + `adapter/src/scheduler/`）。两者输出契约不同（ACP `session/update` vs `Frame`），这也是后文风险清单中「双栈维护」的来源。

### 1.3 设计取舍：长驻子进程 vs 每轮子进程

| 维度 | 链路 A（runtime，本包） | 链路 B（adapter Scheduler） |
| --- | --- | --- |
| 进程模型 | 1 个 `dsh acp` 长驻，会话在其上多路复用 | 每回合 spawn 一个 `dsh --profile agentrun -` |
| 首 token 时延 | 子进程与 DSH 会话已预热，仅 ACP 请求往返 | 每回合要付进程启动 + DSH 初始化 |
| 会话状态 | 进程内 `Map` 持有，DSH 侧 JSONL 持久化 | 依赖 `--resume` / 环境变量传会话视图 |
| 故障面 | 子进程崩溃会清空全部内存会话（`runtime.ts:255`） | 单回合失败只影响该进程 |
| 隔离性 | 会话间共享一个 DSH 进程（按 sessionId 路由） | 回合间天然隔离 |

---

## 2. 总体架构

### 2.1 分层与数据流

```
┌────────────────────────────────────────────────────────────────────────────┐
│ HTTP 传输层   @huaweicloud/agentarts-sdk  AgentArtsRuntimeApp              │
│               POST /invocations（SSE / JSON）   GET /ping                  │
│               WS /ws：SDK 有该端点，但本包未注册处理器（连接以 1011 关闭）  │
│               · maxConcurrency 限流（超限直接 503 Service busy）            │
│               · AsyncIterable → `data: <json>\n\n` SSE 帧                  │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ payload + RequestContext
┌───────────────────────────────▼────────────────────────────────────────────┐
│ 协议适配层    invocation-handler.ts                                        │
│               action 路由（prompt / list / close / cancel / set_config）    │
│               payload 归一化 → TurnRequest；RuntimeEvent → SSE 事件        │
│               RuntimeError → HTTP 状态码                                    │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────────────┐
│ 会话编排层    runtime.ts  AcpRuntime + PromptRun                            │
│               sessions / byAcp 映射；同会话串行闸门 acquire()              │
│               TurnHandle{events, result, cancel}；事件对账；TTL 淘汰       │
└───┬───────────────────┬───────────────────┬────────────────────────────────┘
    │                   │                   │
┌───▼──────────┐ ┌──────▼──────────┐ ┌──────▼─────────────┐ ┌───────────────┐
│ acp-client   │ │ permission.ts   │ │ prompt.ts          │ │ gateway.ts    │
│ ACP v1 stdio │ │ 审批策略/回调    │ │ 每会话提示词文件    │ │ Gateway MCP   │
│ JSON-RPC 2.0 │ │ 反请求→决策      │ │ 256KB + 三档模式    │ │ 控制面解析    │
└───┬──────────┘ └─────────────────┘ └──────┬─────────────┘ └──────┬────────┘
    │ stdin/stdout NDJSON                    │ 文件                │ HTTPS
┌───▼──────────────────────────┐  ┌──────────▼───────────┐  ┌──────▼────────────┐
│ dsh acp 子进程（私有临时 cwd）│  │ DSH 插件             │  │ AgentArts 控制面   │
│ + assistant-token-stream 插件 │  │ system-prompt-       │  │ GatewayClient      │
│ + system-prompt 插件          │  │ injector.mjs         │  │ 目标端点 / Authorizer│
│ + sessions-dir patch          │  │ (读提示词文件)        │  │                    │
└───────────────────────────────┘  └──────────────────────┘  └───────────────────┘
```

### 2.2 依赖方向（单向，无环）

```
config.ts ──────────────────────────────► types.ts
   │ (常量路径)
   ▼
gateway.ts ──► errors.ts        prompt.ts ──► errors.ts
   │                                │
   ▼                                ▼
runtime.ts ◄── acp-client.ts / permission.ts / prompt.ts / gateway.ts / async-queue.ts
   │
   ├──► app.ts ──► invocation-handler.ts（只依赖 runtime 的公开方法）
   └──► main.ts ──► app.ts
index.ts：统一再导出（公共 API 面）
```

规则：`types.ts` / `errors.ts` 是最底层；`runtime.ts` 是唯一编排者；`invocation-handler.ts` 通过 `AcpRuntime` 的方法访问能力，不直接触碰 ACP。

---

## 3. 模块清单

| 文件 | 行数 | 核心导出 | 职责要点 |
| --- | --- | --- | --- |
| `src/index.ts` | 11 | 全部公共 API 再导出 | 包的唯一入口，`exports` 指向 `dist/index.js` |
| `src/main.ts` | 26 | `createDshApp(config)` | 装配 `AcpRuntime` + `AgentArtsRuntimeApp`，注册 SIGINT/SIGTERM 优雅关停（覆盖率为进程引导豁免） |
| `src/app.ts` | 31 | `createRuntimeApp(runtime, opts)` | 包装 SDK App：注入 `maxConcurrency`、lifespan（`onStartup` 可选 eager、`onShutdown` → `dispose`）、`entrypoint` |
| `src/invocation-handler.ts` | 257 | `createInvocationHandler(runtime)`、`SESSION_HEADER` | `/invocations` 的 action 路由、请求归一化（含 `eventId`/`attempt`）、SSE 事件投影、HTTP 状态码映射 |
| `src/runtime.ts` | 753 | `AcpRuntime` | 会话注册表、配额与串行闸门、会话退役/隔离、子进程生命周期、`PromptRun`（文本对账 / 事件预算 / 权限路由 / 截止信号） |
| `src/acp-client.ts` | 328 | `AcpClient` | ACP v1 stdio JSON-RPC 2.0：请求-响应、通知分发、反向请求、子进程起停、stderr 环形缓冲、`prompt` 截止信号 |
| `src/gateway.ts` | 448 | `GatewayResolver`、`extractEndpoint`、`normalizeMcpServers`、`mergeMcpServers`、`describeMcpServers` | AgentArts Gateway → ACP MCP server 的解析、鉴权头组装、SSE 桥接决策、解析缓存、MCP server 归一化/合并/脱敏描述 |
| `src/permission.ts` | 122 | `PermissionBroker`、`permissionOutcome` | 审批四种模式（allow/reject/cancel/callback）、option 选择、HTTP 回调 + 超时 + fallback、ACP 结果封装 |
| `src/prompt.ts` | 76 | `SystemPromptStore`、`normalizeSystemPromptMode`、`validateSystemPrompt` | 每会话提示词文件写入（`{text,mode}`、0600）、模式别名归一化、256KB 上限 |
| `src/config.ts` | 200 | `loadConfig`、`splitArgs`、`parseAcpChildEnv`、各 `*_PATCH` 常量 | env + 托管元数据 → `RuntimeConfig`；默认 `--patch` 列表；`.env` 加载；带引号参数切分；正整数校验 |
| `src/metadata.ts` | 37 | `readMetadata`、`childEnvironment` | 解析 `agent_metadata`（persona/model/gateway 端点）、拒绝未支持的字段、按白名单构造子进程环境 |
| `src/async-queue.ts` | 79 | `AsyncQueue`、`delay` | push→pull 桥 + 事件预算（单事件 4MB、总量 1024 条/4MB，超限回 false 由回合转 `output_limit`） |
| `src/errors.ts` | 41 | `RuntimeError`、`AcpError`、`toRuntimeError` | 统一错误模型与状态码（`AcpError` → 502，其他 → 500） |
| `src/types.ts` | 161 | `RuntimeConfig`、`TurnRequest`、`TurnHandle`、`RuntimeEvent`、`SessionEntry` 等 | 纯类型，无运行时代码（v8 计为 0%，不参与阈值） |

**插件与挂载文件**

| 文件 | 类型 | 作用 |
| --- | --- | --- |
| `plugins/assistant-token-stream.mjs` | DSH 插件 | 监听进程内 `agent/assistant-stream`，把每个 text/reasoning delta 直接写成 ACP `session/update`，实现真·token 流；仅当 `DSH_ACP_TOKEN_STREAM=1/true` 生效 |
| `plugins/assistant-token-stream.patch.yml` | `--patch` 覆盖 | `insert` 上面插件 |
| `plugins/system-prompt-injector.mjs` | DSH 插件 | 挂在 `system-prompt/assemble` 瀑布最外层，读每会话 JSON 并按 `append/replace/replace-all` 改写最终提示词 |
| `plugins/system-prompt.patch.yml` | `--patch` 覆盖 | `insert` 上面插件 |
| `plugins/sessions-dir.patch.yml` | `--patch` 覆盖（默认挂载） | 重定向 bundle 行 `session-persistence-jsonl` 的 `root`：`AGENTRUN_SESSIONS_DIR` → `<AGENTRUN_DIR>/sessions` → `dshHomePath('sessions')` |
| `plugins/skills-dir.patch.yml` | `--patch` 覆盖（默认挂载） | 重定向 bundle 行 `skill-filesystem` 的 `customSkillDirs` → `<AGENTRUN_DIR>/skills`（缺省 `/home/agentarts/skills`），并重述 `includeDefaultRoots: true` / `watch: false`（patch 整段替换该行 config） |
| `plugins/mcp-sse-bridge.mjs` | 独立 stdio 进程 | legacy MCP HTTP+SSE ⇄ stdio 双向 JSON-RPC 中继（Gateway 目标为 SSE 时的适配器） |

---

## 4. 运行时生命周期

### 4.1 启动

```
node dist/main.js / adapter 调用 createDshApp(config)
  └─ new AcpRuntime(config)
       ├─ mkdtemp(os.tmpdir()/dsh-acp-runtime-)   子进程私有 cwd（隔离 .env 与工作区）
       ├─ new SystemPromptStore()                 mkdtemp(.../dsh-acp-system-prompts-)
       ├─ new GatewayResolver(config.gateway)
       └─ new PermissionBroker(config.permission)
  └─ createRuntimeApp(runtime, {maxConcurrency})
       └─ app.run(host, port)                     端口：PORT(8080)；host：AGENTARTS_BIND_IP/HOST
```

`loadConfig()` 在装配前还会 `readMetadata()`（`agent_metadata` / `AGENT_METADATA` / `AGENT_METADATA_FILE`）并用 `childEnvironment()` 生成白名单子进程环境；详见 §7。

- **懒启动**：默认不 eager，子进程在第一次 `runTurn` 时由 `ensureClient()` 拉起；`options.eager` 可改为 lifespan `onStartup` 预热。
- **`.env` 归属**：`loadConfig()` 先 `process.loadEnvFile(env.DSH_ENV_FILE ?? '.env')`（Node ≥20.12），继承的进程 env 优先；缺失 `.env` 不报错。子进程 cwd 是私有临时目录，因此**不会读到本包的 `.env`**（DSH 会拒绝项目 `.env` 里的 `DSH_*` 变量），业务工作区通过 `session/new` 的 `cwd` 单独传入。

### 4.2 子进程管理（`AcpClient`）

| 关注点 | 实现 |
| --- | --- |
| 命令形态 | 默认 `dsh`（Windows 为 `dsh.cmd`）；`.cmd` 走 `cmd.exe /d /s /c` 并用 `quoteWindows` 处理含空格参数 |
| 协议 | stdin/stdout NDJSON，一行一个 JSON-RPC 2.0 消息；stdout 由 `readline` 逐行解析 |
| 环境 | `config.acpEnv` 由 `childEnvironment()` 白名单（OS/CLI/DSH_*/DEEPSEEK_* 等）构造，再合并 `DSH_ACP_CHILD_ENV` 与托管模型凭证；运行期追加 `DSH_ACP_TOKEN_STREAM`、`DSH_SYSTEM_PROMPT_DIR`。**不再全量继承 `process.env`** |
| 握手 | `initialize` 必须回 `protocolVersion === 1`，否则 502 并重建子进程 |
| 请求超时 | `request()` 默认 `requestTimeoutMs`（60s）；`session/prompt` 传回合 deadline 的 `AbortSignal`（回合 timer 触发 cancel，5s 宽限后 abort 该 deadline） |
| 反向请求 | `onRequest(method, handler)`；未知方法回 JSON-RPC `-32601` |
| 通知 | `onNotification('session/update', …)`，多处理器 |
| stderr | 保留尾部 16KB（`stderrTail`），子进程异常退出时拼进 `AcpError` 消息 |
| 退出 | 先 reject 全部 pending（`finish()`），再广播 `onClosed` 监听 |
| 关停 | `dispose()`：`stdin.end()` + `SIGTERM`，3s 内未退出则 `SIGKILL` |

**崩溃自愈**：`ensureClient()` 用单个在飞 `clientPromise` 去重；`client.onClosed` 只在「关闭的仍是当前 client」时清理 `sessions` / `byAcp`（防旧 client 迟到事件误伤新 client）；初始化失败会先 `dispose()` 该子进程再允许重建。

### 4.3 关停

`main.ts:17` 的 `shutdown()` 只执行一次：`server.close()` → `runtime.dispose()` → `process.exit(0)`。
`dispose()`（`runtime.ts:186`）幂等：标记 `disposed`（此后 `runTurn` 直接 503）、清空会话、移除提示词文件、关子进程、删除两个临时目录。

> 注意：进程被 `SIGKILL` 或异常崩溃时临时目录不会被清理，属已知残留（`os.tmpdir()` 下 `dsh-acp-runtime-*` / `dsh-acp-system-prompts-*`）。

---

## 5. 核心流程

### 5.1 一次 prompt 回合

```mermaid
sequenceDiagram
    participant C as Client
    participant H as invocation-handler
    participant R as AcpRuntime
    participant P as PromptRun
    participant A as AcpClient
    participant D as dsh acp 子进程

    C->>H: POST /invocations {prompt, sessionId, stream?}
    H->>H: normalizePayload → TurnRequest
    H->>R: runTurn(request)
    R->>R: acquire(sessionId) 同会话串行
    R->>R: openSession()（复用 or session/new｜resume）
    R->>P: new PromptRun(...) ; entry.current = run
    R-->>H: TurnHandle{events,result,cancel}
    H-->>C: 200 text/event-stream（AsyncIterable）
    P->>P: 写/删系统提示词文件
    P-->>H: event session / run_started
    P->>A: session/prompt(sessionId, [{type:'text'}])
    A->>D: JSON-RPC request
    D-->>A: notification session/update（token / committed / tool_call / usage）
    A->>R: routeUpdate → byAcp 查找 → run.onUpdate
    R->>P: onUpdate 归一化
    P-->>H: text_start/text_delta/tool_call/usage
    H-->>C: data: {...}\n\n
    D-->>A: 反向请求 session/request_permission
    A->>R: routePermission → run.onPermission
    P->>P: PermissionBroker.decide（策略/回调）
    P-->>H: permission_request + permission_resolved
    D-->>A: result {stopReason}
    P->>P: text_end × channel + 对账 text_correction
    P-->>H: run_finished
    P->>R: queue.end()；finally 释放闸门 / 移除提示词
```

步骤与异常分支：

| 阶段 | 位置 | 失败表现 |
| --- | --- | --- |
| 参数校验 | `invocation-handler.ts · normalizePayload` | `prompt` 缺失、`timeoutMs` 非正数 → 400 `invalid_request`（NaN 会被 `setTimeout` 当 0，故前置拦截） |
| 入队 | `runtime.ts · acquire` | `disposed` → 503 `shutting_down`；排队超过 `queueTimeoutMs` → 503 `queue_timeout`；`signal` 已 abort → 499 `cancelled` |
| 开会话 | `runtime.ts · openSession` | 同 key 但 `cwd` 变化 / `acpSessionId` 已被别的 key 占用 → 409；会话仍在隔离清理中 → 503 `session_unavailable`；Gateway 解析失败 → 400/404/502 |
| 提示词写入 | `runtime.ts · PromptRun.start` | 超 256KB / 空串 / 非法模式 → 400，经 `error` 事件返回 |
| 回合执行 | `runtime.ts · PromptRun.start` | 回合超时 → 退役该 ACP 会话 → `prompt_timeout`(504)；事件预算溢出 → `output_limit`(503)；缺少 `stopReason` → 502；cancel → `cancelled`(499) |
| 结算 | `runtime.ts · PromptRun.start` 的 `finally` | 清 timer、`settled`、删提示词文件、更新 `lastUsedAt`、释放串行闸门 |

### 5.2 会话模型与并发

`AcpRuntime` 维护三张表：

| 字段 | 键 | 值 | 用途 |
| --- | --- | --- | --- |
| `sessions` | 调用方 `sessionId`（我们生成/透传） | `SessionEntry`（含 `quarantined`） | 复用、管理动作寻址、TTL 淘汰 |
| `byAcp` | ACP `sessionId`（DSH 侧） | `SessionEntry` | 把 `session/update`、`request_permission` 路由回正确的回合 |
| `queues` | 调用方 `sessionId` | 等待者 `Set`（FIFO） | 同会话串行闸门（不同会话并行） |

- **串行与配额**：`acquire()` 用「每会话等待者队列 + 移交令牌」保证同 `sessionId` 同时只有一个回合；排队超过 `queueTimeoutMs`（默认 60s）→ 503 `queue_timeout`，等待期间 `signal` abort → 499 `cancelled`；先到先服务，取消者不会插队。
- **会话复用**：命中 `sessions` 且 `cwd` 一致即复用，事件里 `reused: true`；否则 `session/new`（或 `session/resume`，当请求带 `acpSessionId`）。请求的 MCP server 会与 Gateway 解析结果、部署级 `AGENTRUN_ACP_MCP_SERVERS` 按名字合并。
- **模型应用**：新建会话后按 `session/new` 返回的 `configOptions` 选中模型。`rc.3` 把 provider+model 编成一个不透明选择值，因此按 `[provider, model]` 路由匹配（provider 缺省依次尝试 `agentarts-model`、`deepseek-official`）；匹配不到直接 502 `model_unavailable`，不会静默跑错模型。`DSH_ACP_REASONING_EFFORT` 直传。
- **会话退役（quarantine）**：`retireSession()` 先把入口标记 `quarantined` 再 `session/close`，成功后删除本地映射；关闭失败则保持隔离，后续 `runTurn` 直接 503 `session_unavailable`，避免复用状态可疑的会话。回合超时也会走退役。
- **TTL 淘汰**：`prune()` 在开会话成功/失败路径触发，只淘汰「无进行中回合且空闲超过 `sessionTtlMs`」的条目，并同步清 `byAcp` 与提示词文件。
- **管理动作**：`listSessions`（透传 `session/list`，支持 `cwd`/`cursor`）、`closeSession`（取消在飞回合 → `retireSession`，未知 key 返回 false）、`cancelSession`（只取消在飞回合，无则 false）、`setConfig`（model / reasoning_effort / 任意 `configOptions`，未知会话 404）。

### 5.3 文本事件与对账

DSH 的两种文本视图在此合并：

| 视图 | 来源 | 标记 | 处理 |
| --- | --- | --- | --- |
| token 增量 | `assistant-token-stream` 插件直写 stdout | `_meta['dsh-acp/token'] === true`，`messageId: token-<attemptId>` | 追加到 `state.text` 并立即 `text_delta` |
| 提交块 | `dsh-acp` 原生 `agent_message_chunk` | 无标记 | 追加到 `state.committed`；若已收到 token **不再发 delta**（防重复） |

- `channel`：`agent_message_chunk` → `message`，`agent_thought_chunk` → `thought`。
- token delta 会原样带上游 `_meta` 的 `attemptId` / `revision`（若提供），便于下游按 attempt 去重或排序。
- 回合结束时 `finalText()` 优先取 `committed`（提交块是权威文本），其次 `text`。
- 若开启 token 流且 `committed !== text`，回合末发一条 `text_correction`（`reason: 'token/committed divergence'`）以便下游纠正，然后每个 channel 发 `text_end`。
- **事件预算**：SSE 队列单事件上限 4MB、累计 1024 条或 4MB；超限时 `push` 返回 false → 回合标记 overflow 并主动 cancel，最终以 `output_limit`(503) 结束（超大单事件会替换为 `event_dropped` 提示帧）。`stream:false` 的队列被禁用，不缓存任何事件，因此不会因输出长而累积内存。
- 其余 ACP update：`tool_call` / `tool_call_update` / `usage_update` 分别投影为 `tool_call` / `tool_call_update` / `usage`，未知类型落到通用 `update`。

### 5.4 权限反向请求

```
session/request_permission
  → AcpClient 反向请求分发（acp-client.ts:274）
  → AcpRuntime.routePermission：按 byAcp 找会话与 PromptRun，找不到直接回 cancelled
  → PromptRun.onPermission：发 permission_request 事件 → PermissionBroker.decide → 发 permission_resolved
  → permissionOutcome()：{outcome:{outcome:'selected', optionId}} | {outcome:{outcome:'cancelled'}}
```

| `mode` | 行为 | `source` |
| --- | --- | --- |
| `allow` / `reject` / `cancel` | 固定策略，不起回调 | `policy` |
| `callback` + `callbackUrl` | POST `{requestId, sessionId, toolCall, options}`，读 `decision` / `outcome.optionId` / `optionId` | `callback` |
| `callback` 无 URL | 直接用 `fallback` | `fallback`（带 `error: no approval callback configured`） |
| 任意模式下 `signal` 已 abort | 取消 | `aborted` |

- option 选择优先级：allow → `allow_once` / `allow_always` / `allow`；reject → `reject_once` / `reject_always` / `reject`；都未命中则取数组首项。
- 超时：内部 `AbortController` + `timeoutMs`（默认 300s），异常/超时走 `fallback`（默认 `cancel`）。
- 请求级覆盖：`request.permission` 与全局配置浅合并，生成一次性 `PermissionBroker`。

### 5.5 系统提示词注入

文件协议（本包写、DSH 插件读）：

```
<DSH_SYSTEM_PROMPT_DIR>/<safe(acpSessionId)>.json = {"text": "...", "mode": "append|replace|replace-all"}
```

| 阶段 | 行为 |
| --- | --- |
| 每回合开始（`PromptRun.start`） | 取 `request.systemPrompt ?? config.systemPrompt.text`；有值则写入（覆盖旧文件），无值则删除 |
| 插件侧（`system-prompt/assemble` 瀑布） | `prepend: true` 注册，先 `await next()` 拿到全部其他贡献，再按模式改写 `sections` / `contexts` |
| 每回合结束 / close / prune / dispose | 删除该会话文件 |

模式语义：

| 模式 | 效果 |
| --- | --- |
| `append`（默认） | 插到 `deployment:persona-prefix` 之后；找不到 persona 则追加末尾 |
| `replace` | 替换 persona 段，保留 harness 身份、运行时上下文与工具指引 |
| `replace-all` | 只保留注入段 + `required === true` 的 contexts，其余 section/context 全部丢弃 |

限制：非空、≤ 256000 字节（`MAX_SYSTEM_PROMPT_BYTES`），模式支持别名（`add`/`increment`、`override`、`replaceAll`/`complete`）。调试可用 `DSH_SYSTEM_PROMPT_DEBUG_FILE` 落盘最终 assembly（仅插件侧）。

> 该设计用「瀑布 hook + 每回合落文件」而非 `agent/created` 时的一次性注册，因此**复用的会话也能逐回合改变提示词**。

### 5.6 AgentArts Gateway MCP 解析

```
resolve(override)                    gateway.ts:188
  ├─ enabled = override.enabled ?? (mcpUrl || gatewayId 存在)
  ├─ 缓存：key = {mcpUrl, gatewayId, targetId, targetName, transport, serverName, serverType}
  │        cacheable = override 未携带任何凭据/自定义头（CREDENTIAL_FIELDS）
  ├─ resolveEndpoint()
  │    ├─ mcpUrl 直连（source = direct）
  │    └─ gatewayId + targetId/ targetName：
  │         getGateway(id)（Authorizer 元数据，可失败）
  │         → getGatewayTarget | listGatewayTargets（按 targetName 大小写不敏感匹配）
  │         → extractEndpoint() 兼容 snake/camel 与多层嵌套（target_configuration → mcp_server → connection）
  ├─ buildHeaders()：自定义头 → apiKey → bearerToken → accessToken → userId
  └─ 传输选择：
       useSse = transport==='sse' || (transport!=='http' && (serverType 含 'sse' || endpoint 以 /sse 结尾))
       ├─ SSE → ACP server = {name, command: process.execPath, args:[SSE_BRIDGE, endpoint],
       │                        env:[{name:'MCP_BRIDGE_HEADERS', value: JSON(头)}]}  // meta.transport = sse-bridge
       └─ 否则 → ACP server = {name, type:'http', url: endpoint, headers}  // meta.transport = http
```

关键细节：

- **API Key 头规则**：未显式指定 `apiKeyHeader` 时，默认 `Authorization`，并自动加 `Bearer ` 前缀（除非头名本身含 `bearer`）；`useAuthorizerKey !== false` 时优先复用控制面返回的 authorizer 密钥。
- **凭据隔离**：请求级覆盖只要出现任一凭据字段，就既不读缓存也不回填缓存，避免 TTL 内不同调用方串用凭据（测试 `gateway.test.ts:63` 覆盖）。
- **脱敏**：`meta.endpoint` 走 `redactUrl()`（去 userinfo/query/hash）；`describeMcpServers()` 只暴露 `headerNames` / `envNames`，不暴露值。
- **`normalizeMcpServers()`**：请求自带 MCP server 归一化为 ACP 形状；`type:"sse"` 直接 400（ACP 不支持，必须走 bridge）；`http` 需要 `url`；stdio 需要 `command`。
- **合并**：`mergeMcpServers()` 按 name（小写去空格）去重，后者覆盖前者，保留首次出现顺序。

### 5.7 HTTP 面（`/invocations`）

一次请求先看 `action`（默认 `prompt`）：

| `action` | 别名 | 需要 `sessionId` | 行为 |
| --- | --- | --- | --- |
| `prompt` | `invoke` / `chat` / `run` | 否（可由 `x-hw-agentarts-session-id` 或随机 UUID 兜底） | 一次 ACP 回合；`stream !== false` 返回 SSE，否则返回 JSON |
| `list` | `list_sessions` / `sessions` | 否 | 透传 `session/list`（可带 `cwd`、`cursor`） |
| `close` | — | 是 | 关会话，返回 `{closed, sessionId}` |
| `cancel` | — | 是 | 取消在飞回合，返回 `{cancelled, sessionId}` |
| `set_config` | `config` | 是 | `model` / `reasoningEffort` / `configOptions[]`，返回 `{sessionId, applied[]}` |
| 其他 | — | — | 400 `invalid_action` |

- 会话头：`prompt`（`stream:false`）、`close`、`cancel`、`set_config` 的 JSON 响应带 `x-hw-agentarts-session-id`（`SESSION_HEADER`，与 SDK 常量一致）；`list` 与错误响应不带，SSE 响应由 SDK 的 `StreamingResponse` 包装亦不带。
- SSE 帧由 SDK 统一包装为 `data: <compact json>\n\n`（`_convertToSse`），handler 只需返回 `AsyncIterable`。
- 非流式成功：`{output, thought, stopReason, sessionId, acpSessionId, cwd}`；失败：`{error:{code,message,statusCode?,data?}}`，HTTP 状态码取 `result.error.statusCode`。
- 流式失败：HTTP 仍是 200，错误通过 `error` 事件 + `run_finished(stopReason)` 表达。

---

## 6. 对外契约

### 6.1 模块公共 API（`src/index.ts`）

```ts
export { AcpRuntime }                                  // 运行时主体
export { createRuntimeApp }                            // 装配 AgentArtsRuntimeApp
export { createDshApp }                                // 进程级装配 + 信号处理
export { createInvocationHandler }                     // 单独挂 entrypoint
export { loadConfig, splitArgs }                       // 配置
export { AcpClient }                                   // 协议客户端
export { GatewayResolver, describeMcpServers, mergeMcpServers }
export { PermissionBroker }
export { SystemPromptStore, normalizeSystemPromptMode }
export { RuntimeError, AcpError, toRuntimeError }
export type * from './types.js'
```

### 6.2 `/invocations` 请求字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` / `input` / `message` | string | 必填，三者按序取第一个非空 |
| `sessionId` | string | 缺省用请求头 `x-hw-agentarts-session-id`，再无则随机 UUID |
| `eventId` / `attempt` | string / number | 事件标识与轮次，透传到 `TurnRequest`（供上层关联重试） |
| `stream` | boolean | 默认 `true`；`false` 走单次 JSON |
| `cwd` | string | 会话工作区，默认 `DSH_AGENT_CWD`/`DSH_ACP_CWD`/`process.cwd()`；同一 `sessionId` 变更 cwd → 409 |
| `acpSessionId` | string | 指定后走 `session/resume` 而非 `session/new` |
| `mcpServers` | array | 见 `normalizeMcpServers`；`sse` 类型被拒 |
| `gateway` | object | 请求级 Gateway 覆盖（含凭据时不复用缓存） |
| `systemPrompt` / `systemPromptMode` | string | 覆盖本回合提示词与模式 |
| `permission` | string \| object | 字符串等价 `{mode}`；与全局配置浅合并 |
| `timeoutMs` | number | 回合超时，须为正数，默认 `promptTimeoutMs` |
| `action` | string | 见 §5.7 |

### 6.3 SSE 事件（`RuntimeEvent` → 投影后）

| `type` | 关键字段 | 说明 |
| --- | --- | --- |
| `session_ready` | `sessionId, acpSessionId, cwd, reused, mcpServers` | 内部事件名为 `session`，投影时改名 |
| `run_started` | `runId, requestId, sessionId, acpSessionId` | |
| `text_start` / `text_delta` / `text_end` | `channel('message'\|'thought'), messageId, token, delta`（token delta 另含 `attemptId?`/`revision?`） | token 流或提交块，见 §5.3 |
| `text_correction` | `channel, text, messageId, reason` | token 与提交块分歧时的权威文本 |
| `event_dropped` | `eventType, reason` | 单事件超过 4MB 时替换原事件，避免撑爆缓冲 |
| `tool_call` | `toolCallId, title, name, kind, status, content, rawInput` | |
| `tool_call_update` | `toolCallId, status, content, rawOutput` | |
| `usage` | `used, size` | 上下文用量 |
| `permission_request` | `requestId, sessionId, acpSessionId, toolCall, options, expiresAt` | |
| `permission_resolved` | `requestId, decision, optionId, source` | `source ∈ policy/callback/fallback/aborted` |
| `error` | `code, message, statusCode, data` | 流内错误，HTTP 仍 200 |
| `run_finished` | `stopReason, output, thought` | 终帧；`stopReason ∈ end_turn/timeout/cancelled/error/…` |
| `update` | `sessionUpdate, update` | 未识别 ACP update 的兜底 |

### 6.4 ACP 协议面

| 方向 | 方法 | 用途 |
| --- | --- | --- |
| client → agent | `initialize` | `protocolVersion: 1`，声明无 fs/terminal 能力 |
| client → agent | `session/new` / `session/resume` | 建/恢复会话，带 `cwd` + `mcpServers` |
| client → agent | `session/list` | 管理动作 `list` |
| client → agent | `session/set_config_option` | model / reasoning_effort / 任意 configId |
| client → agent | `session/prompt` | 回合主体，`prompt:[{type:'text'}]`，无请求超时 |
| client → agent（通知） | `session/cancel` | 取消在飞回合 |
| client → agent | `session/close` | 关闭会话 |
| agent → client（通知） | `session/update` | 文本/工具/用量 |
| agent → client（反向请求） | `session/request_permission` | 审批，返回 `{outcome:{outcome,…}}` |

---

## 7. 配置参考（env → `RuntimeConfig`）

### 7.1 HTTP / 进程与托管元数据

| env | 字段 | 默认 | 说明 |
| --- | --- | --- | --- |
| `PORT` | `port` | 8080 | 仅正整数生效 |
| `AGENTARTS_BIND_IP` / `HOST` | `host` | `null`（SDK 自行推断） | |
| `AGENTRUN_MAX_CONCURRENCY` / `DSH_ACP_MAX_CONCURRENCY` | `maxConcurrency` | 15 | 由 SDK 执行，超限 503 |
| `AGENT_RUNTIME_TYPE` | `agentRuntimeType` | `DSH` | `DSH` / `DSH_HEADLESS` / `PI` / `CODEX`，adapter 用它选择链路 A/B |
| `DSH_ACP_LOG_LEVEL` | `logLevel` | `info` | **已解析但未被消费** |
| `DSH_ENV_FILE` | — | `.env` | `.env` 文件路径 |
| `agent_metadata` / `AGENT_METADATA` / `AGENT_METADATA_FILE` | — | — | 托管元数据：JSON 文本或文件路径。字段 `system_prompt`、`model_config{name,base_url,api_key,credential_provider_name}`、`mcp_gateway_config.endpoint`；非法 JSON/类型直接抛错，`allowed_tools` 被拒绝 |

托管元数据是本包与 AgentArts 控制面的契约：`system_prompt` 成为默认系统提示词、`model_config` 提供模型名/端点/密钥、`mcp_gateway_config.endpoint` 作为 Gateway `mcpUrl` 的回退。环境变量始终优先于元数据。

### 7.2 DSH 子进程

| env | 字段 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DSH_ACP_COMMAND` | `acpCommand` | `dsh`（win: `dsh.cmd`） | |
| `DSH_ACP_ARGS` | `acpArgs` | `--profile acp [--patch token] --patch system-prompt --patch skills --patch sessions` | 显式设置后**不再**注入默认 patch |
| `DSH_ACP_CHILD_ENV` | `acpEnv` | `{}` | JSON 对象；非法 JSON/非对象**直接抛错**；仅字符串值生效，叠加在白名单环境之上 |
| `DSH_ACP_REQUEST_TIMEOUT_MS` | `requestTimeoutMs` | 60000 | ACP 请求默认超时（prompt 由回合 deadline 控制） |
| `DSH_ACP_VERBOSE` | `verbose` | false | 子进程收发报文打到 stderr |
| `DSH_ACP_TOKEN_STREAM` | `tokenStream` | true | 关掉则不挂 token 插件（退化为提交块流） |

子进程环境由 `metadata.ts · childEnvironment` 白名单构造：只放行 OS/CLI 变量（`PATH`、`HOME`、`COMSPEC`、`TEMP`…）、`DSH_HOME`/XDG 目录、`DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`、`NODE_EXTRA_CA_CERTS`/`SSL_CERT_*` 等；平台侧凭证（如 `AGENTARTS_*`）不会进入子进程。所有整数型 `DSH_ACP_*` 只有正整数才生效，其余回退默认值。

### 7.3 会话与回合

| env | 字段 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DSH_AGENT_CWD` / `DSH_ACP_CWD` | `workspaceCwd` | `process.cwd()` | 会话默认工作区（子进程 cwd 另用私有临时目录） |
| `DSH_ACP_MODEL` | `model` | 元数据 `model_config.name` | 新建会话后按 ACP 路由匹配并设置 |
| `DSH_ACP_MODEL_PROVIDER` | `modelProvider` | — | 模型路由前缀，缺省依次尝试 `agentarts-model`、`deepseek-official` |
| `AGENTRUN_ACP_MCP_SERVERS` | `deployedMcpServers` | `[]` | 部署级 MCP server JSON 数组（按名字与请求/Gateway 合并）；非法数组或条目直接抛错 |
| `DSH_ACP_REASONING_EFFORT` | `reasoningEffort` | — | |
| `DSH_ACP_SESSION_TTL_MS` | `sessionTtlMs` | 1800000 | 空闲会话淘汰 |
| `DSH_ACP_PROMPT_TIMEOUT_MS` | `promptTimeoutMs` | 600000 | 回合 deadline：到点 cancel，5s 宽限后 abort，并退役该 ACP 会话 |
| `DSH_ACP_QUEUE_TIMEOUT_MS` | `queueTimeoutMs` | 60000 | 同会话排队上限，超时 503 `queue_timeout` |

### 7.4 审批

| env | 字段 | 默认 |
| --- | --- | --- |
| `DSH_ACP_PERMISSION_MODE` | `permission.mode` | `callback`（非法值回退 callback） |
| `DSH_ACP_APPROVAL_CALLBACK_URL` | `permission.callbackUrl` | `null` |
| `DSH_ACP_APPROVAL_HEADERS` | `permission.headers` | `{}`（JSON） |
| `DSH_ACP_APPROVAL_TIMEOUT_MS` | `permission.timeoutMs` | 300000 |
| `DSH_ACP_PERMISSION_FALLBACK` | `permission.fallback` | `cancel`（仅 allow/reject 被接受，其余 cancel） |

### 7.5 系统提示词

| env | 字段 | 默认 |
| --- | --- | --- |
| `DSH_SYSTEM_PROMPT` | `systemPrompt.text` | 元数据 `system_prompt` | 请求级 `systemPrompt` 优先级最高 |
| `DSH_SYSTEM_PROMPT_MODE` | `systemPrompt.mode` | `append`（仅 replace/replace-all 被接受） | |
| `DSH_SYSTEM_PROMPT_DIR` | 子进程 env | 由 runtime 生成，不读用户配置 |
| `DSH_SYSTEM_PROMPT_DEBUG_FILE` | 插件专用 | 可选，落盘最终 assembly |

### 7.6 AgentArts Gateway

| env | 字段 | 默认 |
| --- | --- | --- |
| `DSH_AGENTARTS_GATEWAY_ENABLED` | `enabled` | 未设置 = 按是否有 `mcpUrl`/`gatewayId` 自动启用 |
| `DSH_AGENTARTS_GATEWAY_MCP_URL` | `mcpUrl` | 元数据 `mcp_gateway_config.endpoint`（直连模式） |
| `DSH_AGENTARTS_GATEWAY_ID` | `gatewayId` | — （控制面模式） |
| `DSH_AGENTARTS_GATEWAY_TARGET_ID` / `DSH_AGENTARTS_GATEWAY_TARGET_NAME` | `targetId` / `targetName` | — |
| `DSH_AGENTARTS_GATEWAY_SERVER_NAME` | `serverName` | `agentarts-gateway` |
| `DSH_AGENTARTS_GATEWAY_SERVER_TYPE` | `serverType` | — （含 `sse` 走桥） |
| `DSH_AGENTARTS_GATEWAY_TRANSPORT` | `transport` | `auto` / `http` / `sse` |
| `DSH_AGENTARTS_GATEWAY_HEADERS` | `headers` | `{}` |
| `DSH_AGENTARTS_GATEWAY_API_KEY` / `DSH_AGENTARTS_GATEWAY_API_KEY_HEADER` | `apiKey` / `apiKeyHeader` | — |
| `DSH_AGENTARTS_GATEWAY_BEARER_TOKEN` | `bearerToken` | — |
| `DSH_AGENTARTS_GATEWAY_ACCESS_TOKEN` / `DSH_AGENTARTS_GATEWAY_ACCESS_TOKEN_HEADER` | `accessToken` / `accessTokenHeader` | 头名默认 `X-HW-AgentGateway-Workload-Access-Token` |
| `DSH_AGENTARTS_GATEWAY_USER_ID` / `DSH_AGENTARTS_GATEWAY_USER_ID_HEADER` | `userId` / `userIdHeader` | 头名默认 `X-HW-AgentGateway-User-Id` |
| `DSH_AGENTARTS_GATEWAY_USE_AUTHORIZER_KEY` | `useAuthorizerKey` | true |
| `DSH_AGENTARTS_GATEWAY_CACHE_TTL_MS` | `cacheTtlMs` | 300000 |

### 7.7 只被插件（而非 TS）消费的变量

`AGENTRUN_DIR`、`AGENTRUN_SESSIONS_DIR`：由 `childEnvironment()` 白名单转发进子进程，DSH 启动时由 `!!js` patch 求值（见 `plugins/skills-dir.patch.yml`、`plugins/sessions-dir.patch.yml`）；父进程未设置时回退 `/home/agentarts`。`DSH_SYSTEM_PROMPT_DEBUG_FILE`（`system-prompt-injector` 调试落盘）、`DSH_ACP_TOKEN_STREAM`（同时透传子进程）、`MCP_BRIDGE_HEADERS`（SSE bridge 进程内）由插件消费。`DSH_ACP_MAX_SESSIONS` 仅出现在 `.env.example`，代码未解析。

---

## 8. 错误模型与状态码

`RuntimeError{code, statusCode, data}` 是唯一跨层错误载体；`AcpError` 是协议层错误（JSON-RPC code）。

| code | HTTP | 触发点 |
| --- | --- | --- |
| `invalid_request` | 400 | payload 缺失 `prompt`、`timeoutMs` 非法、未知 `action`、管理动作缺 `sessionId` |
| `invalid_system_prompt` / `system_prompt_too_large` / `invalid_system_prompt_mode` | 400 | 提示词校验 |
| `mcp_sse_unsupported` | 400 | 请求自带 `type:"sse"` 的 MCP server |
| `gateway_target_unavailable` | 400 / 502 | 缺 `mcpUrl`/`gatewayId`（400）、控制面查询失败（502） |
| `gateway_target_not_found` | 404 | 按 `targetName` 未匹配到目标 |
| `gateway_target_endpoint_missing` | 502 | 目标结构里找不到端点字段 |
| `session_not_found` | 404 | `set_config` 传了未知会话 |
| `session_cwd_mismatch` | 409 | 同 `sessionId` 换 `cwd` |
| `session_conflict` | 409 | 请求的 `acpSessionId` 已被别的会话占用 |
| `session_unavailable` | 503 | 会话正在退役/已被关闭（`quarantined`） |
| `queue_timeout` | 503 | 同会话排队超过 `queueTimeoutMs` |
| `output_limit` | 503 | 回合事件超出缓冲预算（4MB / 1024 条） |
| `model_unavailable` | 502 | 配置的模型不在该 ACP 会话的选项目录中 |
| `cancelled` | 499 | 入队前被 abort，或回合被 cancel/abort |
| `prompt_timeout` | 504 | 回合 deadline 超时 |
| `acp_error` | 502 | 子进程退出 / ACP 报错（`data.acpCode`/`data.acpData`） |
| `shutting_down` | 503 | `dispose()` 之后 |
| `internal_error` | 500 | 其他 |

非 `RuntimeError` 的异常在 handler 内一律按 400 处理；流式路径的 `error` 事件携带同样的 `statusCode` 供下游判断。

---

## 9. 并发、超时与资源治理一览

| 机制 | 参数 | 作用域 | 位置 |
| --- | --- | --- | --- |
| 全局并发 | `maxConcurrency`（15） | `/invocations` 同时处理数，超限 503 | SDK `_invokeHandler` |
| 同会话串行 | `queueTimeoutMs`（60s） | 同一 `sessionId` 的排队与回合 | `runtime.ts · acquire` |
| ACP 请求超时 | `requestTimeoutMs`（60s） | 除 `session/prompt` 外全部请求 | `acp-client.ts · request` |
| 回合 deadline | `promptTimeoutMs`（600s）或请求 `timeoutMs`，cancel 后 5s 宽限 | 一次 `session/prompt`；超时即退役会话 | `runtime.ts · PromptRun` |
| 事件预算 | 单事件 4MB、累计 1024 条 / 4MB | SSE 事件队列（`stream:false` 不缓存） | `async-queue.ts` |
| 审批超时 | `permission.timeoutMs`（300s） | 一次权限回调 | `permission.ts · decide` |
| Gateway 解析缓存 | `cacheTtlMs`（300s） | 无凭据覆盖的解析结果 | `gateway.ts · resolve` |
| 会话空闲淘汰 | `sessionTtlMs`（30min） | `sessions` 条目 | `runtime.ts · prune` |
| 子进程强杀 | 3s | `dispose()` | `acp-client.ts · dispose` |
| SSE 桥等待端点 | 30s | bridge 进程启动 | `mcp-sse-bridge.mjs` |
| stderr 缓冲 | 16KB | 子进程诊断 | `acp-client.ts · start` |
| 提示词大小 | 256000 bytes | 单会话提示词 | `prompt.ts` |

---

## 10. 测试架构

`vitest.config.ts`：`include: test/**/*.test.ts`，v8 覆盖率，`src/**` 行覆盖阈值 80%（当前 84.06%）。`src/types.ts` 是纯类型模块、`src/main.ts` 是进程引导（绑定端口 + 信号处理），二者由 v8 计为低覆盖，不影响逻辑模块的阈值含义。

测试不依赖真实 `dsh`：`test/fixtures/fake-acp.mjs` 是最小 ACP 假进程（`initialize` / `session/new` / `session/list` / `session/prompt` / `session/close` / `session/set_config_option` / `session/cancel` 通知），默认先发 2 个 token 块、再发 1 个提交块、再发 `tool_call`/`tool_call_update`，回 `{stopReason:'end_turn'}`；并支持 `hang`（挂起等待 cancel）、`ignore-cancel`（不响应取消）、`fail-prompt`（JSON-RPC error）、`flood`（1200 条 usage 事件）、`malformed-stdout`（非 JSON 行）等故障注入。

| 文件 | 用例数 | 覆盖点 |
| --- | --- | --- |
| `config.test.ts` | 7 | 默认 4 个 patch（token / system-prompt / skills / sessions）及关闭 token 时的顺序、sessions 三级优先级求值、skills 挂载求值、显式 `DSH_ACP_ARGS` 不被改写 |
| `gateway.test.ts` | 18 | API Key → `Authorization: Bearer`、SSE 目标走 stdio 桥并透传头、嵌套端点提取、凭据覆盖与 TTL 缓存、控制面按名选目标/鉴权头复用、404/502/400 错误、MCP server 归一化/合并/脱敏 |
| `invocation.test.ts` | 9 | SSE 可迭代 + token 帧数、`stream:false` JSON、`list/close/cancel/set_config` 管理动作、非法 `timeoutMs` → 400、`session_not_found` → 404、`dispose` 后 503、真实 HTTP SSE 端到端 |
| `permission.test.ts` | 11 | allow/reject/cancel 策略、回调成功/裸 decision/HTTP 错误/超时、无回调 fallback、已 abort、无匹配 kind 选首项、`permissionOutcome` 序列化 |
| `prompt.test.ts` | 6 | 模式别名、256KB 上下界、`SystemPromptStore` 文件名净化/写入/幂等删除/非法输入/不可写目录 |
| `async-queue.test.ts` | 4 | 大事件直投、超大事件替换为提示帧、`fail()` 拒绝等待者与后续迭代、`end()` 后忽略 push、禁用队列不缓存 |
| `metadata.test.ts` | 3 | `DSH_ACP_CHILD_ENV` 非法输入、托管元数据映射到 model/persona、平台凭证不进子进程、并发上限回退 |
| `runtime.test.ts` | 9 | token 流 + 提交文本为最终 output、会话复用、FIFO 与 abort、排队超时、非响应 prompt 退役、事件预算与 `output_limit`、Gateway 发现期取消、模型路由与部署级 MCP |
| `runtime-management.test.ts` | 6 | `list`、`close`（重复关闭）、`setConfig`（全字段 + 404）、`cancelSession`、cwd 冲突 409、dispose 幂等与 503 |
| `index.test.ts` | 1 | 包入口可导入 |
| **合计** | **74** | 10 个文件全部通过 |

未被单测覆盖的关键路径（供补充用例参考）：子进程崩溃后的 `ensureClient` 竞态重建、`text_correction` 对账、`replace-all` 提示词、`session/resume`、`prune` 的实际淘汰、`mcp-sse-bridge.mjs` 的 SSE 中继。

---

## 11. 构建、运行与部署

```bash
pnpm install
pnpm --filter @agentarts/harness-dsh-runtime build      # tsc -p tsconfig.json → dist/
pnpm --filter @agentarts/harness-dsh-runtime test
pnpm --filter @agentarts/harness-dsh-runtime start      # node dist/main.js
```

- `tsconfig.json` 继承 `../tsconfig.base.json`：ES2023 / NodeNext / strict / declaration + sourcemap。
- 发布内容（`package.json#files`）：`dist`、`plugins`、`.env.example`、`README.md`。**`plugins/` 必须在产物内**，因为 `config.ts` 用 `import.meta.url` 推导 `../plugins` 绝对路径并传给 `--patch`。
- `dist/` 与 `coverage/` 被根 `.gitignore` 忽略；仓库里的 `runtime/dist` 是本地构建产物。
- 容器部署要点：
  1. 子进程 cwd 是私有临时目录，所以业务工作区必须通过 `session/new.cwd`（`DSH_AGENT_CWD`）显式传入；
  2. `AGENTRUN_DIR` 挂载 `skills/`、`sessions/`：`skills-dir.patch.yml` 设置 `skill-filesystem.customSkillDirs`，`sessions-dir.patch.yml` 重定向会话存储；两者都由 `childEnvironment()` 白名单转发进子进程，父进程未设置时回退 `/home/agentarts`；
  3. 两个 patch 都是**整行 config 替换**（loader 不深合并），`skills-dir.patch.yml` 因此重述了 `includeDefaultRoots` / `watch`，sessions 若要覆盖 `compression`、`listConcurrency` 也必须写在同一文件；
  4. 子进程 env 是白名单（`metadata.ts · childEnvironment`，OS/CLI、`DSH_*`、`DEEPSEEK_*`、`AGENTRUN_DIR`/`AGENTRUN_SESSIONS_DIR` 等）+ `DSH_ACP_CHILD_ENV` 显式叠加，平台凭证不继承；
  5. `dsh` 需在 PATH 中，或通过 `DSH_ACP_COMMAND` 指到绝对路径。

---

## 12. 已知问题与改进建议

上一版文档中的四项问题已在当前代码解决：回合超时无兜底（现在 deadline + 会话退役）、非流式路径累积事件（现在禁用队列 + 事件预算）、子进程环境全量继承（现在白名单）、`cancel()` 在子进程退出后可能抛错（现在 `client.running` 守卫）。其余待办：

| 优先级 | 问题 | 位置 | 建议 |
| --- | --- | --- | --- |
| P2 | `closeSession` / `setConfig` 内部 `ensureClient()` 在子进程未运行时拉起新进程，只为关闭/配置一个已不存在的会话 | `runtime.ts · closeSession/setConfig` | 会话不在内存时直接返回/抛 404，不触碰子进程 |
| P2 | `dist/` 残留 `scheduler.js/.d.ts/.map`（源码已无 `scheduler.ts`），`tsc` 不会清除旧产物 | `runtime/dist` | 构建前 `rimraf dist`，避免发布脏产物 |
| P2 | `logLevel` 与 `.env.example` 的 `DSH_ACP_MAX_SESSIONS` 未生效，配置面与实际行为不一致 | `config.ts` | 实现或移除 |
| P2 | 权限事件 `expiresAt` 用的是全局审批超时，请求级 `permission` 覆盖后二者可能不一致 | `runtime.ts · onPermission` | 用本回合实际配置 |
| P2 | 会话退役失败会保持 `quarantined`，只有显式 close 或子进程退出才清除；期间该 key 持续 503 | `runtime.ts · retireSession` | 加有限重试或后台清理，避免长期占用 |
| P3 | `prune()` 只在开会话路径触发，长期没有新会话时空闲会话不会被淘汰 | `runtime.ts · prune` | 增加定时清理 |
| P3 | `main.ts`（`createDshApp`、信号关停）无单测，只覆盖进程引导，逻辑改动易回归 | `src/main.ts` | 用假 server 测一次装配 + 关停 |
| P3 | `promptStore.remove` / `complete()` 与 `finally` 重复更新 `lastUsedAt` | `runtime.ts · PromptRun` | 收敛为单一更新点 |
| P3 | `normalizePayload` 用条件展开构造对象，字段增删易错 | `invocation-handler.ts` | 改为逐字段赋值 + 校验函数 |
| P3 | adapter（Scheduler/Frame）与 runtime（ACP 直连）两套实现并存，输出契约不同 | `adapter/src/main.ts` | 明确收敛方向（建议以 ACP 为唯一实现），或在 README 标注两条链路的能力差异 |

---

## 13. 术语

| 术语 | 含义 |
| --- | --- |
| ACP | Agent Client Protocol v1：`initialize` / `session/*` / `session/prompt`，JSON-RPC 2.0 over stdio（NDJSON） |
| DSH | DeepSeek Harness，本包驱动的 agent 宿主；`dsh acp` 是其 ACP 服务端形态 |
| Turn / 回合 | 一次 `session/prompt` 到 `stopReason` 的完整过程 |
| `--patch` | DSH 的加载器覆盖文件（`insert` 插件或替换某 bundle 行 `config`） |
| Frame | 链路 B 的 NDJSON 事件词汇（`shared/src/frames.ts`），与 ACP `session/update` 不同 |
| token 流 / 提交块 | token 流是逐 token 的 `agent/assistant-stream` 增量；提交块是回合提交后的一整段 assistant 文本 |
| 反向请求 | 子进程向父进程发起的 JSON-RPC 请求（`session/request_permission`） |

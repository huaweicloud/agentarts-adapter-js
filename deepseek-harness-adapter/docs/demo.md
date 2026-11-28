# ACP 部署与验证 demo

本 demo 按 **ACP 路线**验证：`dsh acp` 常驻子进程 + AgentArts 记忆、OBS 技能与可观测（APM/AOM）三个插件 + `agent_metadata` 配置注入。构建产物的协议烟测由 `scripts/smoke.mjs` 执行。详细集成说明见 [ACP-INTEGRATION.md](ACP-INTEGRATION.md)。

## 1. 准备

- Node.js >= 24.9、pnpm 12.x。
- 一个可执行的 DSH CLI（`@deepseek-ai/dsh`，含 `acp` profile）。用 `DSH_ACP_COMMAND` / `DSH_ACP_ARGS` 指向它，不要求在 PATH 上。
- 隔离的 `DSH_HOME` 与工作区 `DSH_AGENT_CWD`。

在本目录执行：

```bash
pnpm install
pnpm --filter @agentarts/harness-dsh-shared run build
pnpm --filter @agentarts/harness-dsh-runtime run build
pnpm --filter @agentarts/harness-dsh-adapter run build
```

## 2. 配置环境变量

`agent_metadata` 接受完整 JSON/YAML（model_config/memory_config/mcp_config/skills/user_bucket/system_prompt）。其余变量按部署需要注入（ACP 子进程使用显式环境变量白名单）：

```cmd
set "agent_metadata={...完整 JSON...}"
set HUAWEICLOUD_SDK_AK=...
set HUAWEICLOUD_SDK_SK=...
set OBS_ENDPOINT=https://obs.cn-southwest-2.myhuaweicloud.com
set DSH_HOME=D:\temp\agentarts-demo-home
set AGENTRUN_DIR=D:\SB
set DSH_AGENT_CWD=D:\temp\agentarts-demo-work
set DSH_ACP_COMMAND=node
set DSH_ACP_ARGS=D:\temp\dsh-cli\node_modules\@deepseek-ai\dsh\lib\bin.js --profile acp
```

> `DSH_ACP_ARGS` 会完全替换默认参数，必须自己带上 `--profile acp`。模型/记忆/MCP 的 `credential_provider_name` 会在启动时经 identity 服务换 key 注入，不需要内联真实 key。

## 3. 生成 acp profile（插件挂载前提）

```cmd
node --input-type=module -e "import {loadAdapterConfig} from './adapter/dist/config.js'; import {materializeProfile} from './adapter/dist/patch.js'; const p = materializeProfile(loadAdapterConfig()); console.log('acp profile:', p.profileDir)"
```

生成 `DSH_HOME/profiles/acp/`（含 `package.json`、`vendor/`、`node_modules/`、`cordis.patch.yml`）。bundles 含 `@deepseek-ai/dsh-acp-app` + 三个插件；vendor 依赖（`esdk-obs-nodejs` 等）指纹未变时跳过重复安装。

## 4. 启动 ACP 服务

```cmd
node adapter/dist/main.js
```

启动时 `loadHostedDshConfig()` 解析部署配置并解析凭据，随后 `startHostedHarness()` 装配协议入口。以 `GET /ping` 返回 `Healthy` 为就绪信号。

## 5. 发请求验证（用 Node，避免 PowerShell GBK 编码）

```cmd
node -e "fetch('http://127.0.0.1:18092/invocations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'demo-acp-1',prompt:'我叫什么？另外，现在支持哪些 skill？',stream:false})}).then(r=>r.text()).then(t=>console.log(t))"
```

> **中文注意**：不要用 PowerShell 的 `Invoke-RestMethod` 直接发中文 body（GBK 编码会变 `?`）。用 Node 的 `fetch`（默认 UTF-8）。

## 6. 验证点

| 验证项 | 预期 |
| --- | --- |
| 模型路线 | `session/set_config_option` 为 `["agentarts-model","<model_name>"]`，不再回退 `deepseek-official` |
| 记忆召回 | 模型主动调 `huawei_memory_search`，能答出记忆中的人名/项目代号（tool 模式） |
| OBS 技能 | `<AGENTRUN_DIR>/skills/` 下有 `json-processor/`、`markdown-formatter/`，模型能列出 |
| 多 MCP gateway | `mcp_config` 数组里每个 gateway 都挂进 `session/new` 的 `mcpServers`，能调对应工具（如 `12306_query_train_tickets`） |
| 插件激活 | 无 `did not activate`、无 `JsonSchemaError` |

## 7. 常见问题

- **`deepseek-official: no API key`**：模型路线回退到了默认 route。检查 `applyModelConfig` 是否把 `agent_metadata` 的模型名正确映射到 `["agentarts-model","<name>"]`（group 嵌套匹配已修复），以及 `MODEL_API_KEY` 是否经 identity 注入。
- **`Not Found`（404）**：模型路线或 base_url/模型名错误，确认用的是 `agentarts-model` route 而非 `deepseek-official` 的默认模型。
- **中文变 `?`**：PowerShell 的 GBK 编码问题，改用 Node 的 `fetch` 发请求。
- **插件 `Cannot find package`**：acp profile 未生成或 vendor 未装上，回到第 3 步。

其余集成细节（架构、env 映射表、时序图、与 headless 的差异）见 [ACP-INTEGRATION.md](ACP-INTEGRATION.md)。

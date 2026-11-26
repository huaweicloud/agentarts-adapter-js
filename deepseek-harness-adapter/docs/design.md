# DeepSeek Harness Adapter — 当前实现说明（ACP 路线）

> 架构权威来源是工作区根目录《架构设计.md》。本文件只记录 **ACP 路线**下的代码落点；旧的 headless 调用方仍可显式选择 `AGENT_RUNTIME_TYPE=DSH_HEADLESS`。

## 当前里程碑

以 `dsh acp` 常驻子进程替代 headless 一次性进程，挂载 AgentArts 记忆与 OBS 技能两个插件，`agent_metadata` 经翻译层注入 ACP 配置。

## 代码落点

| 文件 | 职责 |
| --- | --- |
| `shared/src/env.ts` | main 的 ACP env 常量 + dev 的 `ADAPTER_ENV`/`MODEL_ENV` 等常量（已合并） |
| `adapter/src/config.ts` | `agent_metadata` 解析与校验、`buildChildEnv`（memory/skills/凭证/MCP headers）、诊断脱敏 |
| `adapter/src/credential.ts` | `resolveCredentials`：经 identity 服务换模型/记忆/MCP 的 key |
| `adapter/src/acp-config.ts` | **翻译层**：`agent_metadata` → `DSH_ACP_CHILD_ENV` + `DSH_ACP_MODEL` + `DSH_SYSTEM_PROMPT` + `AGENTRUN_ACP_MCP_SERVERS` |
| `adapter/src/patch.ts` + `profile/` | `materializeProfile`：生成 `DSH_HOME/profiles/acp/`（bundles + vendor 依赖落地，指纹未变跳过安装） |
| `adapter/src/ops.ts` | DSH dump 解析、插件清单、reconcile（不再对账 headless-runner） |
| `adapter/src/main.ts` | 服务入口：`loadHostedDshConfig()` → `startHostedHarness()` |
| `runtime/`（main） | `AcpClient`（spawn `dsh acp`）、`AcpRuntime`（多 session 复用）、`applyModelConfig`（group 嵌套匹配）、`openSession`（合并部署级 `AGENTRUN_ACP_MCP_SERVERS`） |
| `plugins/dsh-agentarts-memory` | 记忆插件（tool 模式模型主动 search；save 存短期记忆，平台自动提取长期记忆） |
| `plugins/dsh-skill-obs` | OBS 技能插件（下载到 `<AGENTRUN_DIR>/skills`） |

## 数据流

```text
agent_metadata / env / argv
  → loadAdapterConfig（启动时解析一次，缓存）
  → loadHostedDshConfig
      ├─ resolveCredentials（identity 换模型/记忆/MCP key）
      └─ applyAgentMetadataToAcpEnv
            ├─ DSH_ACP_MODEL / DSH_SYSTEM_PROMPT
            ├─ DSH_ACP_CHILD_ENV（memory/skills/凭证/agent_metadata 原样 JSON）
            └─ AGENTRUN_ACP_MCP_SERVERS（全部 gateway）
  → startHostedHarness
        └─ AcpRuntime.runTurn → openSession（复用或新建）
              └─ session/new({cwd, mcpServers}) → session/prompt
                    └─ 插件：记忆 search/save、OBS 技能、MCP 调用
```

## 与 headless 的关键差异

- **进程模型**：headless 每轮一个子进程；ACP 一个常驻子进程多 session 复用。
- **配置注入**：headless 用 profile patch 渲染 + `buildChildEnv` 白名单；ACP 用 `agent_metadata` → `DSH_ACP_CHILD_ENV`（部署白名单 + 显式 JSON 覆盖）。
- **MCP**：headless 渲染 `dsh-mcp-client` 行；ACP 用 `session/new` 的 `mcpServers`（多 gateway，per-session）。
- **启动器**：headless 是 `scheduler/run.ts` 的 `spawnCaptured`；ACP 是 `runtime/acp-client.ts` 的 `AcpClient`。

详细部署、env 映射、时序图与验证见 [ACP-INTEGRATION.md](ACP-INTEGRATION.md)；部署与验证步骤见 [demo.md](demo.md)。

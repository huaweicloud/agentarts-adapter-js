# DeepSeek Harness Adapter — 当前实现说明

> 架构权威来源是工作区根目录《架构设计.md》。本文件只记录当前代码落点，不再保留早期对话中的自拟 env 键或「召回走 env」方案。

## 当前里程碑

实现 Adapter 侧配置注入与启动器，保留官方 `headless-runner` 和本地持久化后端。自研 runner、turn、context、capability 和 DataLake 接管属于后续模块。

## 代码落点

| 文件                                     | 职责                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `shared/src/env.ts`                      | agent_metadata、AGENTRUN__、DEEPSEEK__、MCP/DataLake 键与白名单常量                 |
| `adapter/src/config.ts`                  | 配置合并与校验、白名单 env（按 §3.5 分类注入，不整体注入 agent_metadata）、诊断脱敏 |
| `adapter/src/credential.ts`              | CredentialProvider seam：SDK 凭证解析 + 静态 demo provider                          |
| `adapter/src/recall.ts`                  | 可替换 RecallProvider、静态 demo provider、300ms 超时与空召回降级                   |
| `adapter/src/patch.ts` + `profile/`      | 启动时渲染并写入 profile 三件套；密钥只通过 `!!js process.env` 引用                 |
| `adapter/src/scheduler/session-queue.ts` | 同 sessionId 串行                                                                   |
| `adapter/src/scheduler/resident.ts`      | 停驻进程管理：预挂载、每轮信封写入、帧解析、final 判定、崩溃重建、就绪状态          |
| `adapter/src/scheduler/run.ts`           | DSH argv、spawn、stdin、NDJSON、退出判定、超时回收、prepare/run/probe               |
| `adapter/src/ops.ts`                     | 解析 DSH dump、插件清单查询、快照和 reconcile                                       |
| `adapter/src/main.ts` + `scripts/`       | render/inspect/demo/run/resident 五种验收入口                                       |

## 数据流

```text
agent_metadata / env / argv
  → loadAdapterConfig
  ├→ renderPatch → profile 三件套 → DSH --dump-config → AdapterOps.reconcile
  └→ RecallProvider → 召回结果
                         ↓
InvocationRequest → SessionQueue → spawn DSH → stdin(信封：prompt + recall + 身份)
                         ↓
                    stdout NDJSON → final + exitCode → 调用方
```

召回结果走输入信封（stdin），不进环境变量；信封还携带 sessionId、eventId、attempt 与 prompt。MCP 网关 `mcp_config`（数组）的 `protocol_type: "mcp"` 渲染为 `dsh-mcp-client` 的 `streamable-http` transport。

## 当前兼容模式与目标模式的差异

当前 profile 不关 `headless-runner`，也不禁 `session-persistence-jsonl`、`attachment-local`、`storage-json`。生产目标中的自研 driver 和 DataLake 替换行将在对应包可安装后启用。ops 当前是静态组合校验，不是运行时 fiber 健康检查。

详细验收见 [demo.md](demo.md)，自行处理的未确定项见 [open-questions.md](open-questions.md)。

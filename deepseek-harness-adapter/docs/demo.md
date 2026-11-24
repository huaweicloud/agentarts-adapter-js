# 配置注入与启动器 demo

本 demo 按根目录《架构设计.md》实现当前里程碑：官方 `headless-runner` 和 DSH 本地会话/附件/KV 后端保持启用，自研 runner、turn/context/capability 与 DataLake 接管尚未接入。

## 1. 准备

- Node.js >= 24.9（与 DSH 0.2.2-rc.5 一致）。
- pnpm 12.21.0。
- 一个可执行的 DSH CLI。`dsh` 不必在 PATH 上，可以用 `--dsh-command` 和 `--dsh-arg` 指向它。
- 使用隔离的 `DSH_HOME` 和子进程 cwd，且两处都不要放 `.env`。DSH 会额外读取这两个位置的 `.env`，仅做 spawn env 白名单并不能消除该来源。

在本目录执行：

```bash
pnpm install
pnpm build
```

DSH 启动示例：

```text
# dsh 已在 PATH
--dsh-command dsh

# 已安装的 npm 包
--dsh-command node --dsh-arg /absolute/path/node_modules/@deepseek-ai/dsh/lib/bin.js

# 当前工作区源码（需先在该源码仓完成 pnpm install 和构建）
--dsh-command node --dsh-arg D:/DSH_DEV/deepseek-harness-master/apps/cli/lib/bin.js
```

## 2. 配置

参考配置：[scripts/demo.agentarts.yaml](../scripts/demo.agentarts.yaml)。复制后再修改，避免把真实凭证写进仓库。

支持三种配置来源，优先级为：

```text
argv（--metadata / --set）> 环境变量 > --config 挂载文件 > 内置默认值
```

环境变量 `agent_metadata` 接受完整 JSON/YAML，字段与架构文档末尾的结构一致；`AGENT_METADATA` 仅作为 Adapter 输入的大写兼容别名：

```powershell
$env:agent_metadata = '{"agent_metadata":{"system_prompt":"Answer briefly.","skills":"D:/demo/skills","model_config":{"name":"deepseek-chat","base_url":"https://api.deepseek.com","api_key":"demo-only-key"}}}'
```

模型 key 和端点也可以由 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL` 覆盖。其他字段通过 `agent_metadata` 或 argv 的 `--set agent_metadata.<字段>=<值>` 修改，不再转换成另一套配置键。

### 子进程收到的主要键

| 键                                                        | 内容                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`                  | DSH 官方模型 provider 直接读取的值                                                      |
| stdin（信封 JSON）                                        | `sessionId` / `eventId` / `attempt` / `prompt` / `recall`（身份与召回走信封，不进 env） |
| `MCP_<SERVER>_URL`                                        | 每个 MCP 上游的端点                                                                     |
| `AGENTRUN_DSH_MCP_<SERVER>_HEADERS`                       | 每个上游的鉴权 header JSON，patch 通过 `!!js` 读取                                      |
| `AGENTRUN_DATALAKE_*`                                     | 预留给 DataLake 插件的端点与凭证                                                        |
| `DSH_HOME` / `DSH_AGENTS_HOME` / `DSH_TELEMETRY_DISABLED` | 隔离 home、隔离共享指令根、关闭 OTel                                                    |

完整常量集中在 [shared/src/env.ts](../shared/src/env.ts)。`agent_metadata` 是 Adapter 的输入（平台 env / 挂载文件 / argv），Adapter 解析后按 §3.5 分类注入子进程：模型 key/端点进 `DEEPSEEK_*`、MCP 端点进 patch 与 `MCP_*_URL`、DataLake 凭证进 `AGENTRUN_DATALAKE_*`；**不把整个 `agent_metadata` JSON 注入子进程 env**，记忆/知识库检索凭证留在 Adapter 做召回，只有召回结果进信封。

MCP 网关使用 `mcp_config`（数组，每个元素一个网关），`protocol_type: "mcp"` 会在渲染 patch 时固定映射为 `dsh-mcp-client` 的 `streamable-http` transport，其 `endpoint` 作为 `url`。网关与模型的 `api_key` 由 `credential_provider_name` 经凭证解析获得：默认走 SDK（`--credential-provider sdk`），demo 无 SDK 构建时用 `--credential-provider static`，从 `AGENTRUN_CREDENTIAL_<NAME>` 环境变量读密钥（`<NAME>` 是 provider_name 的大写化）。`memory_config` 无 `endpoint` 字段，其 `private_access.domain_name`（优先）与 `public_access.domain_name` 作为端点，供 SDK memory 召回使用。

## 3. 无需模型 key：完整配置与启动验收

下面的命令会做两件事：

1. 用真实 DSH `--dump-config` 启动一个子进程，校验完整组合中的模型、MCP、skills、PTC、官方 runner 和本地存储行；
2. 用同一份 env/stdin 启动一个探针子进程，证明启动器实际传入了这些值。探针不是 DSH 的替代品，报告中的 DSH dump 校验是独立步骤。

```bash
node scripts/demo.mjs \
  --dsh-command node \
  --dsh-arg /absolute/path/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --dsh-home /tmp/agentarts-demo-home \
  --dsh-cwd /tmp/agentarts-demo-work
```

Windows PowerShell 可写成一行：

```powershell
node scripts/demo.mjs --dsh-command node --dsh-arg D:/DSH_DEV/deepseek-harness-master/apps/cli/lib/bin.js --dsh-home D:/temp/agentarts-demo-home --dsh-cwd D:/temp/agentarts-demo-work
```

只校验真实 DSH 装配、不运行探针：

```bash
node scripts/render-check.mjs --dsh-command node --dsh-arg /absolute/path/to/dsh/lib/bin.js
```

只生成 profile、查看实际 env/stdin，不调用 DSH：

```bash
node adapter/dist/main.js render --config scripts/demo.agentarts.yaml
```

重点检查输出：

- `child.env.agent_metadata`：完整的脱敏配置 JSON；
- `child.stdin`：输入信封 JSON（含 prompt 与 recall）；
- `inspect.reconcile.ok`：预期插件行是否全部匹配；
- `inspect.plugins`：模型、MCP、skills、PTC、官方 runner、本地存储的实际组合结果；
- `probe.ok` 和 `probe.frames`：探针收到的 env 与任务；
- 顶层 `ok`：只有 DSH 校验和探针都成功时才为 `true`。

## 4. 使用官方 headless-runner 真正跑一轮

先复制配置并设置实际 skills 路径，再设置真实模型 key：

```powershell
$env:DEEPSEEK_API_KEY = 'your-real-key'
node scripts/smoke.mjs --dsh-command node --dsh-arg /absolute/path/to/dsh/lib/bin.js --task "Reply with a short greeting."
```

`DEEPSEEK_API_KEY` 会覆盖参考配置里的 `demo-only-key`。可用 `--set agent_metadata.model_config.name=deepseek-chat` 和 `DEEPSEEK_BASE_URL` 覆盖模型名和端点。

首次运行不要传 `--session-id`，官方 headless 会新建随机 Session。成功报告中的 `run.frames[0].sessionId` 可用于下一次恢复：

```bash
node scripts/smoke.mjs --session-id session-... --task "Continue the previous conversation"
```

恢复必须使用同一个 `DSH_HOME`、cwd 和已存在的 Session id。成功同时要求子进程退出码为 0、`final.reason.kind` 为 `completed`。

### 无 key 的 DSH 官方 mock（源码 checkout 可选）

DSH 源码提供测试用 mock overlay，可让官方 runner 不请求真实模型：

```powershell
node scripts/smoke.mjs --dsh-command node --dsh-arg D:/DSH_DEV/deepseek-harness-master/apps/cli/lib/bin.js --dsh-patch D:/DSH_DEV/deepseek-harness-master/apps/cli/tests/profiles/headless/tests/fixtures/headless-profile.patch.yml --task "Run the mock round trip"
```

该 overlay 把模型改为 `cli-mock/cli-mock`，所以 reconcile 会显示一条“额外 patch 覆盖了配置”的警告，而不是把模型差异当作错误。mock 属于 DSH 测试资产，不是生产 provider。

## 5. 当前兼容实现的边界

- 召回结果已按设计进入输入信封（stdin），但默认 runner 不会读取它；需等 `capability.ts` 接入后才会成为模型上下文。
- `eventId`/`attempt` 已注入，但默认 runner 不做幂等判重；需等 `turn.ts`。
- `system_prompt` 会追加到 headless 的 personaPrefix；`skills` 映射到官方 `skill-filesystem.customSkillDirs`。
- `allowed_tools` 仅完成 env 注入，默认 runner 不执行工具白名单；需等 `context.ts`。
- DataLake 尚未接管，`session-persistence-jsonl`、`attachment-local`、`storage-json` 保持启用。
- 官方 runner 输出块级 `text` 和 `final`，不是目标自研 driver 的 token 级 `delta`。
- ops 查询的是 DSH 组合后的插件行和配置，不是运行时 fiber 激活状态或服务健康；缺失服务诊断需要后续进程内检查插件。
- 全局并发上限由 agentarts SDK 负责；本 demo 只实现同 sessionId 串行。

其他自行处理的决策与未确定项见 [open-questions.md](open-questions.md)。

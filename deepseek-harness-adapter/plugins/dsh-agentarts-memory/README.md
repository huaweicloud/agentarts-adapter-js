# AgentArts memory bundle

本包是 `@agentarts/dsh-agentarts-memory`，为 AgentRun profile 提供华为云 AgentArts 长期记忆。代码 vendor 自 `dsh-agentarts-memory` 0.2.0（MIT，见 `LICENSE`），保留其零运行时依赖的数据面客户端。

## 能力

- `recall`：在 `agent/pre-step` 按当前用户文本检索记忆，把相关命中注入模型消息。
- `tools`：注册 `huawei_memory_search` 和直接写入用的 `huawei_memory_save`。
- `capture`：在 `session/disposed` 后通过 `add_messages` 上传对话，由平台自动提取长期记忆；AgentRun 默认开启，设 `AGENTRUN_MEMORY_CAPTURE=0` 可关闭。
- `/agentarts`：在提供命令服务的 DSH 形态中查看状态或临时检索。

召回和采集均为 best-effort，云端失败不会中断对话。未配置记忆空间时 `apply()` 不注册任何能力。

## Adapter 集成

`adapter/src/patch.ts` 会把本包的运行文件复制到渲染后的 profile，并将 `@agentarts/dsh-agentarts-memory` 加入 bundle 列表。`cordis.patch.yml` 只从子进程环境读取配置，不写入密钥：

| 环境变量 | 来源与用途 |
| --- | --- |
| `AGENTRUN_MEMORY_SPACE_ID` | `agent_metadata.memory_config.id`；存在时启用插件 |
| `AGENTARTS_MEMORY_DATA_ENDPOINT` | 私网优先的 `domain_name`；为空时使用区域默认端点 |
| `HUAWEICLOUD_SDK_MEMORY_API_KEY` | 内联 `api_key`、CredentialProvider 或 Adapter 环境中的同名变量 |
| `AGENTRUN_MEMORY_STRATEGY_ID` | 仅直接 `POST /memories` 写入时可选；`add_messages` 自动提取不需要 |
| `HUAWEICLOUD_SDK_REGION` | 区域；默认 `cn-southwest-2` |
| `AGENTRUN_MEMORY_CAPTURE` | 默认自动采集；设为 `0` 关闭，设为 `1` 显式开启 |

不要在 `cordis.patch.yml`、profile 或仓库配置中写入真实 API key。

## 验证

```sh
node --test "test/*.test.mjs"
```

测试使用本地模拟数据面，不需要真实记忆空间或网络凭证。真实 DSH 的端到端验证见 [docs/demo.md](../../docs/demo.md) 的记忆库章节。

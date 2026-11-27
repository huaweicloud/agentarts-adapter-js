# plugins

插件目录：每个插件独占一个子目录，由插件开发者自行创建，例如 `plugins/my-plugin/`。

子目录内部结构（src、test 等）由各插件自行约定，仓库不预置公共骨架。

当前插件：

| 目录 | 包名 | 职责 |
| --- | --- | --- |
| `dsh-agentarts-memory/` | `@agentarts/dsh-agentarts-memory` | AgentArts 记忆：召回、工具、自动采集 |
| `dsh-skill-obs/` | `@agentarts/dsh-skill-obs` | OBS 技能下载到 `<AGENTRUN_DIR>/skills` |
| `agentarts-instrumentation-dsh/` | `agentarts-instrumentation-dsh` | AgentArts 可观测（APM/AOM）；vendor 自上游 release，env 优先配置 |

挂载：`adapter/src/patch.ts` 的 `HOST_PLUGINS` 把每个插件的运行文件复制到 profile 的
`vendor/` 与 `node_modules/`，并登记进 `profile/package.json` 的 `dsh.profile.bundles`，
因此 DSH 加载 profile 时无需从 npm 安装插件。

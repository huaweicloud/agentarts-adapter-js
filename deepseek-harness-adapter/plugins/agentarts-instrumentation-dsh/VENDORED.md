# Vendored plugin provenance

本目录是上游发布产物 **逐字节一致** 的 vendor 拷贝，供 profile 装配（`adapter/src/patch.ts` 的 `HOST_PLUGINS`）复制进
`DSH_HOME/profiles/<profile>/vendor/agentarts-instrumentation-dsh/` 与
`node_modules/agentarts-instrumentation-dsh/`，使 DSH 无需从 npm 安装即可加载该插件。

- 上游仓库：https://github.com/huaweicloud/agentarts-instrumentation-js
- 包名 / 版本：`agentarts-instrumentation-dsh` `1.0.0-rc.5`
- 来源产物：`agentarts-instrumentation-dsh-1.0.0-rc.5.tgz`（sha256
  `db13d2d6df8d4f7e3ed23c6fca1517fd4ede2b8afddb1ce2d2b14288c5a2a0c7`），
  本目录文件与其解包内容哈希一致（含 `package.json`，未做任何改动）
- 运行时入口：`dist/plugin.mjs`（单文件 ESM bundle，零运行时依赖）
- 更新方式：用新版本 tgz 解包后整体替换本目录内容，并同步
  `adapter/src/patch.ts` 的 `assets` 清单与 `profile/package.json` 的 bundles/依赖。

> 该目录已通过 `pnpm-workspace.yaml` 的 `!plugins/agentarts-instrumentation-dsh` 排除出
> pnpm workspace：上游 `package.json` 的 `build`/`test`/`devDependencies` 面向插件源码开发，
> 仓库级 `pnpm build`/`pnpm test` 不应执行它们，`dist/plugin.mjs` 是发布产物而非构建输出。

## 配置方式（环境变量优先）

插件运行配置读取 `~/.dsh/plugins/agentarts-instrumentation-dsh/config.json`（JSONC）；
容器/托管场景无需维护配置文件，插件会直接读取 **同名 otel 环境变量**（优先级
`config.json < 同名环境变量 < ${VAR} 展开`）。适配层把这份清单登记为
`shared/src/env.ts` 的 `INSTRUMENTATION_ENV`（按仓库约定大写命名，也接受下表小写写法），
并在注入 DSH 子进程时统一归一化为插件要求的小写键名。下表为插件实际读取的小写键：

| 环境变量 | 类型 | 说明 |
| --- | --- | --- |
| `agentarts_agentops_otel_agent_apm_enable` | 布尔 | 是否上报调用链（APM） |
| `agentarts_agentops_otel_agent_aom_enable` | 布尔 | 是否上报指标（AOM） |
| `agentarts_agentops_apm_token` | 字符串 | APM 接入凭证 |
| `agentarts_agentops_apm_exporter_endpoint` | 字符串 | APM 上报地址 |
| `agentarts_agentops_aom_access_code` | 字符串 | AOM 接入码 |
| `agentarts_agentops_aom_exporter_endpoint` | 字符串 | AOM 上报地址 |
| `agentarts_agentops_aom_prometheus_id` | 字符串 | AOM Prometheus 实例 ID |
| `agent_domain_id` | 字符串 | 账号 domain ID |
| `agentarts_project_id` | 字符串 | 华为云项目 ID |
| `agent_resource_id` | 字符串 | AgentArts 智能体资源 ID |
| `resource_type` | 字符串 | 资源类型（默认 `agent`） |

需要离线 `config.json` 时，可在容器内用插件自带的
`configure/dsh-agentarts-plugin.(ps1|sh)` 脚本生成（凭据建议走 `DSH_AGENTARTS_APM_TOKEN` 环境变量）。

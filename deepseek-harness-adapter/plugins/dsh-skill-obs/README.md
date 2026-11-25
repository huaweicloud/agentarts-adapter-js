# @agentarts/dsh-skill-obs

容器启动时，把声明在 `agent_metadata.skills` 里的技能**全量从 OBS 下载到 SFS 挂载目录**，在首个模型调用前准备完成，交给 DSH 的 `skill-filesystem` 加载。

## 工作方式

1. **挂载即下载并等待**：`apply` 是 async 函数，启动时立即下载全部技能；Cordis 会等待 `apply` 返回的 Promise，而 headless-runner 在创建 agent 前会 `await loader.await()`，因此**下载在首次 catalog 组装（pre-step）之前必然完成**，模型第一次调用时技能目录已就绪。
2. **目录静态注入**：`cordis.patch.yml` 同时把 `skill-filesystem.customSkillDirs` 指向同一挂载目录，路径注入与内容下载并行。

> 注意：不要只在 `agent/pre-step` 里 `await` 下载——catalog 的监听器可能先于它执行而生成空目录。必须让 `apply` 返回 Promise 并由 loader 等待，才能保证 catalog 在下载完成后组装。

每个技能的处理流程：按刷新策略处理目标目录 → 下载 zip（OBS SigV4 签名）→ 解压（防 Zip Slip、限制大小）→ 删除压缩包 → 修复 frontmatter（`description` 自动加引号）。

## 刷新策略（两档）

| `forceRefresh` | 行为 | 适用 |
|---|---|---|
| **`false`（默认，含未设置）** | 目标目录已存在且含合法 `SKILL.md` 就**跳过下载**（`items[].cached: true`）；无效才重下 | **SFS 共享挂载目录**，多会话复用同一份缓存，避免重复下载和互相覆盖 |
| `true` | 每次启动先删目标目录，全量重新下载 | 无共享存储、每次要最新技能 |

切换方式：`AGENTRUN_SKILLS_FORCE_REFRESH=1` 时强制全量重下（`cordis.patch.yml` 中 `forceRefresh: !!js process.env.AGENTRUN_SKILLS_FORCE_REFRESH === '1'`）。**默认（含未设置）就是"存在即跳过"**，挂 SFS 时无需额外配置。

## 配置来源

| 项 | 来源（优先级从高到低） |
|---|---|
| `agent_metadata.skills` | `"skillId:skillName:skillVer, skillId:skillName:skillVer"` |
| `agent_metadata.user_bucket` | OBS 桶名 |
| `AGENTRUN_SKILLS` / `AGENTRUN_USER_BUCKET` | 独立 env 覆盖（无 agent_metadata 时） |
| `AGENTRUN_SKILLS_DIR` | 挂载目录，默认 `/home/agentarts/skills` |
| `HUAWEICLOUD_SDK_REGION` | region，默认 `cn-southwest-2` |
| `HUAWEICLOUD_SDK_AK` / `HUAWEICLOUD_SDK_SK` | OBS 签名凭证（`createCredential()` 的 env provider 读取；生产可改走实例元数据） |
| `HUAWEICLOUD_SDK_SECURITY_TOKEN` | STS 临时 token（可选） |

**凭证与下载**：下载用官方 **`esdk-obs-nodejs`** 的 `ObsClient.getObject({Bucket, Key})`（签名、请求编码、响应解码全部由 SDK 处理，无手写 SigV4）。凭证由 `@huaweicloud/agentarts-sdk` 的 **`createCredential()`** 解析（env → `~/.huaweicloud/credentials` → 实例元数据服务 的凭证链，生产 AgentArts runtime 由元数据服务自动供凭证），返回 `BasicCredentials{ak,sk,securityToken}` 并映射为 ObsClient 的 `access_key_id/secret_access_key/security_token`。
| `OBS_ENDPOINT` | OBS 服务端点（如 `https://obs.cn-southwest-2.myhuaweicloud.com`），未设时按 region 拼默认；bucket 以子域形式拼接（虚拟主机风格） |
| `HUAWEICLOUD_SDK_AGENTIDENTITY_ENDPOINT` | AgentIdentity 服务端点（如 `https://agent-identity.cn-southwest-2.myhuaweicloud.com`），SDK 内部已支持该 env 覆盖，无需改代码 |
| `AGENTRUN_SKILLS_OBS_ENDPOINT` | 测试用 `scheme://host` 覆盖，设置后跳过云签名 |

## zip 布局

- 顶层 `<技能名>/SKILL.md`（与 `D:\temp\agentarts-demo-skills` 参考包一致）→ 解压到挂载根；
- 根目录直接 `SKILL.md` → 解压到 `挂载目录/<技能名>/`。

## 失败与修复

- `description` 含 `: ` 未加引号 → 自动修复并记入 `fixed`；
- 其他问题（下载失败、无 SKILL.md、frontmatter 非法等）→ 记入 `items[].error` 与 `warnings`，**不中断启动**，由插件日志输出。

## 本地验证

```bash
pnpm install
pnpm test
```

测试用内存 zip + 本地 HTTP server，无需真实 OBS。

## 与 Adapter 的关系

插件在 DSH 进程内运行，读取的是 DSH 子进程环境变量。Adapter/平台需要把 `agent_metadata`（含 `skills`、`user_bucket`）和 OBS 凭证注入子进程环境，或在 bundle config 里直接给出 `skills`/`userBucket`。

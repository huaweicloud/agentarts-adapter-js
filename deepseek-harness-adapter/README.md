# agentarts-harness-adapter

华为云 AgentArts 平台上托管 DeepSeek Harness（DSH）的适配层（pnpm monorepo）。

当前已实现配置注入与启动器，并保留官方 `headless-runner` 和本地存储作为可运行兼容形态。自研 runner、turn/context/capability、DataLake 接管与协议面接入不在本次完成范围内。

## 目录结构

```text
deepseek-harness-adapter/
├── shared/     # env 键、公共类型
├── adapter/    # config、patch、recall、ops、scheduler、demo CLI
├── plugins/    # DSH Host 插件集合（每个插件一个独立目录）
│   ├── dsh-agentarts-memory/           # AgentArts 记忆：召回、工具、自动采集
│   ├── dsh-skill-obs/                  # OBS 技能：下载到 <AGENTRUN_DIR>/skills
│   └── agentarts-instrumentation-dsh/  # AgentArts 可观测（APM/AOM）：vendor 自上游 release，env 优先配置
├── helper/     # 12/30 工具沙箱 helper
├── precheck/   # 装包扫描
├── profile/    # agentrun 三件套模板（base + headless + memory）
├── scripts/    # demo、render-check、smoke、child-probe
└── docs/       # 实现、验收和未确定项
```

## 环境要求

- Node.js >= 24.9（对齐 DSH 0.2.2-rc.5）。
- pnpm 12.21.0。
- 验收 DSH 启动时需要可用的 DSH CLI；详见 demo 文档。

## 开发与验证

```bash
pnpm install
pnpm test        # vitest 全量测试 + 记忆插件 node:test 测试
pnpm typecheck   # 全仓类型检查
pnpm build       # 构建各包到 dist/
pnpm format      # prettier 格式化
```

快速入口：

```bash
# 真实 DSH --dump-config + 同 env/stdin 子进程探针（不需要模型 key）
node scripts/demo.mjs --dsh-command node --dsh-arg /absolute/path/to/dsh/lib/bin.js

# 只校验 DSH 组合
node scripts/render-check.mjs --dsh-command node --dsh-arg /absolute/path/to/dsh/lib/bin.js

# 配置模型后使用官方 headless-runner 跑一轮
node scripts/smoke.mjs --dsh-command node --dsh-arg /absolute/path/to/dsh/lib/bin.js --task "Hello"
```

完整的配置说明、Windows 示例、无 key mock、Session 恢复和输出解释见 [docs/demo.md](docs/demo.md)。本次实现自行处理的不确定项见 [docs/open-questions.md](docs/open-questions.md)。

## 约定

- pnpm workspace、TypeScript（NodeNext）、vitest、prettier。
- 不修改 DSH 源码；通过 profile 三件套和 patch 装配。
- 子进程使用白名单 env；记忆插件在 DSH 内召回，任务与兼容信封走 stdin。
- agentarts-instrumentation-dsh 的可观测配置（APM/AOM）优先走环境变量：适配层侧用大写命名（`INSTRUMENTATION_ENV`，也接受插件的小写同名写法），注入 DSH 子进程时归一化为插件要求的小写键名；离线场景可用插件自带 configure 脚本写 `config.json`。
- MCP 只支持 `streamable-http`，拒绝 SSE 和 stdio。

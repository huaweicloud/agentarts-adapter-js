# DSH 插件目录

每个 DSH Host 插件使用一个独立目录，避免包名和 profile 装配互相影响：

```text
plugins/
└── dsh-agentarts-memory/
    ├── package.json       # 包名、exports、dsh.bundle.patch、build/test/clean
    ├── index.js           # Cordis apply/name/inject 入口
    ├── cordis.patch.yml   # 插件行与默认配置
    ├── src/               # 运行时代码
    ├── test/              # 本地测试
    ├── docs/              # 插件详细说明
    ├── locale/            # 插件管理界面元数据
    └── icon.svg
```

`pnpm-workspace.yaml` 使用 `plugins/*`，新增同级目录后执行 `pnpm install` 即可被 workspace 识别。根目录 `pnpm test` 会递归执行所有声明了 `test` 脚本的包。

当前插件：

- `dsh-agentarts-memory`：包名 `@agentarts/dsh-agentarts-memory`，提供 AgentArts 记忆召回、记忆工具和会话自动采集。

新增插件需要接入 AgentRun profile 时，还应更新 `profile/package.json` 和 `adapter/src/patch.ts` 的物化逻辑；仅放入本目录不会自动挂载到 DSH。

# agentrun profile 资产

- `package.json`：按顺序声明 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-headless`。
- `cordis.patch.yml.tmpl`：Adapter 启动时按配置渲染；当前保留官方 runner 和本地存储。
- `cordis.yml`：空根入口列表，DSH 在 boot/dump 时会重写，不能手改。

渲染目标为 `$DSH_HOME/profiles/agentrun/`。MCP 密钥不写进 patch，而是由 `!!js` 在子进程装配时读取白名单 env。

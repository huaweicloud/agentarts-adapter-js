# agentarts-adapter-js

[![License](https://badgen.net/static/License/Apache-2.0/blue)](LICENSE)



华为云agentarts-adapter-js是一个专为在华为云AgentArts平台上进行harness框架Agent托管适配的代码库。该仓库支持基于Deepseek Harness等框架和华为云AgentArts平台进行实现一键开发、部署Agent智能体到华为云上。



## 安装

```sh
npm install @huaweicloud/agentarts-adapter-js
npx agentarts-adapter prepare-profile
npx agentarts-adapter start
```

部署环境需要 Node.js 24.22.3 至 24.x 或 26.13.1 及以上版本，并安装可执行的 `dsh`（Windows 上为 `dsh.cmd`）。也可以通过 `DSH_ACP_COMMAND` 指定 CLI 路径。两个命令从工作目录或 `DSH_HOME` 使用同一套 DSH 配置，默认目录是工作目录下的 `.dsh`。`prepare-profile` 将四个内置插件装配到 `profiles/acp` 并通过 npm 安装 profile 的依赖。配置好模型和凭据后，`start` 启动适配器，默认监听 `127.0.0.1:18092`。

发布前可用 `npm install <tarball>` 安装 Actions 下载的 `.tgz`，再运行上述两个 `npx` 命令。

## npm 发布

在 `deepseek-harness-adapter` 下运行 `pnpm install --frozen-lockfile` 和 `pnpm pack:npm`，产物位于 `dist/npm/`。传入产物路径运行 `node scripts/verify-npm.mjs <tarball>`，可在临时目录验证安装、profile 插件加载和模拟 DSH 调用。

GitHub Actions 的 **Build and publish npm package** 在 PR 和手动运行时生成供下载的 `agentarts-adapter-js-npm` artifact。

### 首次配置 Trusted Publishing

如果 npm 上还没有这个包，由具有 `@huaweicloud` 发布权限的维护者使用 npm 11.15.0 或更新版本，在仓库外创建临时清单并暂存 `0.0.0-bootstrap.0`。npm 会登记包名并创建公开的 `0.0.0-stage` 占位版本。

```powershell
$bootstrapDir = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ('agentarts-npm-bootstrap-' + [guid]::NewGuid()))
Set-Content -LiteralPath (Join-Path $bootstrapDir.FullName 'package.json') -Encoding ascii -Value '{"name":"@huaweicloud/agentarts-adapter-js","version":"0.0.0-bootstrap.0"}'
npm login --registry https://registry.npmjs.org/
npm stage publish $bootstrapDir.FullName --registry https://registry.npmjs.org/ --access public --tag bootstrap
```

在 npm 包设置的 **Trusted Publishing** 中添加 GitHub Actions，填写组织 `huaweicloud`、仓库 `agentarts-adapter-js` 和工作流文件名 `publish-npm.yml`，环境留空，并启用 **Allow `npm publish`**。暂存的 `0.0.0-bootstrap.0` 可通过 **Staged Packages** 拒绝。绑定后请在两天内完成首次 OIDC 发布。

### 发布正式版本

发布流程合入 `main` 后，为包含目标版本的提交推送对应的 `v<version>` 标签。首版 `0.0.1` 对应 `v0.0.1`，后续版本通过 `deepseek-harness-adapter/npm/package.json` 更新。工作流会构建并验证产物，再通过 OIDC 发布同一份 `.tgz`。稳定版使用 `latest`，预发布版使用 `next`。



## API 参考

待补充



## 贡献

查看 [CONTRIBUTING.md](CONTRIBUTING.md)



## 许可证

本项目使用 Apache-2.0 许可证。


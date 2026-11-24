# harness-dsh-adapter（容器主进程）

装配 @huaweicloud/agentarts-sdk 的 AgentArtsRuntimeApp，提供 AgentRun 三端点
（/invocations、/ws、/ping）与 A2A/AG-UI 协议面（SDK 接口就绪后自动注册）。

## 运行

    pnpm install && pnpm build
    PORT=8080 node adapter/dist/main.js

环境变量：PORT（默认 8080）、AGENTRUN_MAX_CONCURRENCY（默认 15）。
子进程 env 白名单见 src/launch-spec.ts。

## 测试

    pnpm test            # 全部（先构建 shared）
    pnpm test:coverage   # 覆盖率阈值 80%

集成测试用假子进程（test/fixtures/fake-dsh.mjs），不依赖真 dsh。
进程级冒烟：node scripts/smoke.mjs（启动构建产物，验证探活/参数校验/错误路径）；
真 dsh 端到端冒烟待 driver 侧就绪后补充。

## 待接线（外部依赖）

- SDK a2a/agui 注册接口：尚未就绪，register.ts 守卫注册，到位后跑三协议联调回归。
- 装配侧 recall/完整白名单/patch 渲染：后续接入 SchedulerDeps。
- 真 dsh 子进程（profile agentrun）：就绪后 buildLaunchSpec 即可用。
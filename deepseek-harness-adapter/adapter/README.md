# harness-dsh-adapter（容器主进程）

装配 @huaweicloud/agentarts-sdk 的 AgentArtsRuntimeApp，提供 AgentRun 三端点
（/invocations、/ws、/ping）与 A2A/AG-UI 协议面（SDK 交付后自动注册）。

## 运行

    pnpm install && pnpm build
    PORT=8080 node adapter/dist/main.js

环境变量：PORT（默认 8080）、AGENTRUN_MAX_CONCURRENCY（默认 15）。
子进程 env 白名单见 src/launch-spec.ts（spec §3.5）。

## 测试

    pnpm test            # 全部（先构建 shared）
    pnpm test:coverage   # 覆盖率阈值 80%

集成测试用假子进程（test/fixtures/fake-dsh.mjs），不依赖真 dsh；
真 dsh 冒烟属 P1（scripts/smoke.mjs）。

## 待接线（外部依赖）

- SDK a2a/agui 面：11/30 交付，register.ts 守卫注册，到位后跑三协议联调回归。
- C 模块 recall/完整白名单/patch 渲染：P3 接入 SchedulerDeps。
- 真 dsh 子进程（profile agentrun）：P1 交付后 buildLaunchSpec 即可用。
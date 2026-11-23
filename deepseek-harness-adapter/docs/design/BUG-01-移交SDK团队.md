# [bug] maxConcurrency 只保护 /invocations，/ws 与新增 A2A/AG-UI 面绕过全局并发上限

## 现象

`AgentArtsRuntimeApp` 的 `maxConcurrency`（默认 15）只对 `POST /invocations` 生效。
WebSocket 连接上的执行不经过任何并发计数，满载也不会被拒绝。即将交付的 A2A/AG-UI
面若沿用同样的注册路径，也将不受保护。

## 根因（源码证据，agentarts-sdk-js main 分支）

- `packages/agentarts-sdk/src/sdk/runtime/app.ts` `_handleInvocation`（~:889）经
  `_invokeHandler`（~:965）做 `_activeInvocations >= maxConcurrency` 检查，满载返回 503。
- 同文件 `_handleWebsocket`（~:1168）**直接调用注册的 websocket handler**，不经过
  `_invokeHandler`，不增不减 `_activeInvocations`。
- `/ping` 的 HealthyBusy 判定（~:765）同样只反映 invocations 计数。
- Python 版 `agentarts-sdk-python` 的 `app.py` 存在同构缺口（TS 按 PORTING.md 1:1
  移植而来）；修复需同步 Python 版，或在 PORTING.md 明确记录此行为差异。

## 影响

适配层（agentarts-adapter-js 的 DSH Worker）每轮执行 spawn 一个子进程。N 个 WS
客户端各发不同 sessionId 的轮次 → 同时 spawn N 个子进程，无上限保护，沙箱 CPU/内存
耗尽。设计文档（huaweicloud/agentarts-adapter-js issue #6 §4.4、§1.4 决策 11）明确
"全局并发上限由 SDK maxConcurrency 执行，三套协议面全部经过这两级控制"——当前实现
未满足该契约，适配层因此无法按设计不自研全局信号量。

## 期望行为（修复契约，请逐条确认）

1. **共享计数器**：invocations / ws / a2a / agui 四面共用同一个全局计数器，
   上限 = `options.maxConcurrency`（不是每面各 N）。
2. **计数粒度 = 一轮执行**，不是连接/handler 调用。ws 一条长连接承载多轮，
   **空闲连接不得占用名额**；名额必须反映"正在执行的轮次（子进程）数"。
3. **permit API**：SDK 无法感知不透明 handler 内部的轮次边界，请向 handler 暴露
   名额获取/释放接口，形状可自定，语义须满足 1/2。示例：

   ```ts
   // RequestContext 上：
   acquireSlot(): Promise<SlotLease>   // 满载时 reject（错误类型可识别）
   interface SlotLease { release(): void }
   // 或包装器形态：app.withConcurrency(fn)
   ```

   invocations 维持现有自动按请求计数；ws/a2a/agui 的 handler（或 SDK 新面在已知
   轮次边界处）用 permit API 按轮 acquire/release。
4. **各面满载响应由协议层定义**：invocations 维持 503（形状不变）；ws/a2a/agui
   的满载拒绝行为请给出明确规范（关连接码 / error 帧 / task rejected / run error），
   适配层按规范翻译。
5. **HealthyBusy**：`/ping` 反映全局计数器（任一面满载即 HealthyBusy）。
6. **向后兼容**：invocations 现有行为（503 形状、session 响应头、SSE 格式）不变。

## 验收标准（可测试）

- maxConcurrency=1：两个不同 sessionId 的 ws 轮次并发发起 → 第二轮按契约被拒/等待，
  任何时刻不超过 1 轮在执行。
- 跨面共享：invocations 占满名额时 ws 轮次被拒；反向亦然。
- 空闲 ws 连接（已建立、未发轮次）不占名额，invocations 仍可执行。
- 全局满载时 /ping 返回 HealthyBusy。
- invocations 现有集成测试全部回归通过。
- A2A/AG-UI 新面交付即计入同一计数器。

## 排期与关联

- 请与 A2A/AG-UI 面**同批 11/30 交付**，作为该批验收项之一（适配层 11/30 判据
  "三套协议各通一条"依赖全面并发保护）。
- 关联：huaweicloud/agentarts-adapter-js issue #6 §4.4 / §1.4 决策 11；
  适配层审查报告 BUG-01（agentarts-adapter-js deepseek-harness-adapter/docs/design/P4-代码审查报告.md）。
- 适配层在 SDK 交付前不做临时信号量（已决策），交付后按本契约接线并补回归测试。
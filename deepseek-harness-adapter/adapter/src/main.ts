import { pathToFileURL } from 'node:url'
import { AgentArtsRuntimeApp } from '@huaweicloud/agentarts-sdk/sdk/runtime'
import { Scheduler } from './scheduler/index.js'
import type { SchedulerLike } from './scheduler/types.js'
import { buildLaunchSpec } from './launch-spec.js'
import { createInvocationHandler } from './handlers/invocations.js'
import { createWsHandler } from './handlers/ws.js'
import { registerProtocolFaces } from './handlers/register.js'
import { TaskRegistry } from './handlers/a2a.js'

/** 解析并发上限 env：非法值（NaN/0/负数/非整数）回退 15，避免限流静默失效 */
export function parseMaxConcurrency(raw: string | undefined): number {
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : 15
}

/** 装配 SDK app，main 只做装配。a2a/agui 守卫注册，SDK 接口就绪后自动生效。 */
export function createApp(scheduler: SchedulerLike, maxConcurrency?: number): AgentArtsRuntimeApp {
    const limit = maxConcurrency ?? parseMaxConcurrency(process.env.AGENTRUN_MAX_CONCURRENCY)
    const app = new AgentArtsRuntimeApp({ maxConcurrency: limit })
    app.entrypoint(createInvocationHandler(scheduler))
    app.websocket(createWsHandler(scheduler))
    registerProtocolFaces(app, scheduler, new TaskRegistry())
    return app
}

// 仅直接运行时启动服务；被测试导入时不启动
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const scheduler = new Scheduler({ launchSpec: buildLaunchSpec })
    createApp(scheduler).run()
}
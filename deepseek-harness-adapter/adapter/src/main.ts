import { pathToFileURL } from 'node:url'
import { AgentArtsRuntimeApp } from '@huaweicloud/agentarts-sdk/sdk/runtime'
import { Scheduler } from './scheduler/index.js'
import { buildLaunchSpec } from './launch-spec.js'
import { createInvocationHandler } from './handlers/invocations.js'
import { createWsHandler } from './handlers/ws.js'
import { registerProtocolFaces } from './handlers/register.js'
import { TaskRegistry } from './handlers/a2a.js'

/** 装配 SDK app（spec §5.2：main 只做装配）。a2a/agui 守卫注册，SDK 交付后自动生效。 */
export function createApp(scheduler: Scheduler, maxConcurrency?: number): AgentArtsRuntimeApp {
    const limit = maxConcurrency
        ?? Number.parseInt(process.env.AGENTRUN_MAX_CONCURRENCY ?? '15', 10)
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
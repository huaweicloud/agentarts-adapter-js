import { pathToFileURL } from 'node:url'
import { AgentArtsRuntimeApp } from '@huaweicloud/agentarts-sdk'
import { Scheduler } from './scheduler/index.js'
import { buildLaunchSpec } from './launch-spec.js'
import { createInvocationHandler } from './handlers/invocations.js'
import { createWsHandler } from './handlers/ws.js'
import { registerProtocolFaces } from './handlers/register.js'
import { TaskRegistry } from './handlers/a2a.js'
import { loadConfig, RuntimeConfig, createDshApp } from '@agentarts/harness-dsh-runtime'


/** 装配 SDK app，main 只做装配。a2a/agui 守卫注册，SDK 接口就绪后自动生效。 */
export function createDefaultApp(config: RuntimeConfig) {
    const scheduler = new Scheduler({ launchSpec: buildLaunchSpec })
    const app = new AgentArtsRuntimeApp({ maxConcurrency: config.maxConcurrency })
    app.entrypoint(createInvocationHandler(scheduler))
    app.websocket(createWsHandler(scheduler))
    registerProtocolFaces(app, scheduler, new TaskRegistry())
    app.run();
}

// 仅直接运行时启动服务；被测试导入时不启动
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const config = loadConfig()
    if (config.agentRuntimeType === 'DSH') {
        createDshApp(config);
    } else {
        createDefaultApp(config)
    }
}
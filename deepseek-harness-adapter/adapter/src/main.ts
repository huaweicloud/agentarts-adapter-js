import { pathToFileURL } from 'node:url'
import { AgentArtsRuntimeApp } from '@huaweicloud/agentarts-sdk'
import { Scheduler } from './scheduler/index.js'
import { buildLaunchSpec } from './launch-spec.js'
import { createInvocationHandler } from './handlers/invocations.js'
import { createWsHandler } from './handlers/ws.js'
import { registerProtocolFaces } from './handlers/register.js'
import { TaskRegistry } from './handlers/a2a.js'
import { loadConfig, RuntimeConfig, createDshApp } from '@agentarts/harness-dsh-runtime'
import { bootstrapAcpFromAgentMetadata } from './acp-config.js'


/** 解析并发上限 env：非法值（NaN/0/负数/非整数）回退 15，避免限流静默失效 */
export function parseMaxConcurrency(raw: string | undefined): number {
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : 15
}

/** 装配 SDK app，main 只做装配。a2a/agui 守卫注册，SDK 接口就绪后自动生效。 */
export function createApp(scheduler: Scheduler, maxConcurrency?: number): AgentArtsRuntimeApp {
    const limit = maxConcurrency ?? parseMaxConcurrency(process.env.AGENTRUN_MAX_CONCURRENCY)
    const app = new AgentArtsRuntimeApp({ maxConcurrency: limit })
    app.entrypoint(createInvocationHandler(scheduler))
    app.websocket(createWsHandler(scheduler))
    registerProtocolFaces(app, scheduler, new TaskRegistry())
    return app
}

export function createDefaultApp(config: RuntimeConfig) {
    const scheduler = new Scheduler({ launchSpec: buildLaunchSpec })
    const app = createApp(scheduler, config.maxConcurrency)
    app.run()
}

// 仅直接运行时启动服务；被测试导入时不启动
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    // agent_metadata → ACP env（在 runtime/loadConfig 之前注入，loadConfig 随后读取）
    await bootstrapAcpFromAgentMetadata()
    const config = loadConfig()
    if (config.agentRuntimeType === 'DSH') {
        createDshApp(config);
    } else {
        createDefaultApp(config)
    }
}
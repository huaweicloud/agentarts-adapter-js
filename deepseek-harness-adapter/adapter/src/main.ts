import { pathToFileURL } from 'node:url'
import { AgentArtsRuntimeApp } from '@huaweicloud/agentarts-sdk'
import { Scheduler } from './scheduler/index.js'
import { normalizeRequest } from './request.js'
import { buildLaunchSpec } from './launch-spec.js'
import { createInvocationHandler } from './handlers/invocations.js'
import { createWsHandler } from './handlers/ws.js'
import { registerProtocolFaces } from './handlers/register.js'
import { TaskRegistry } from './handlers/a2a.js'
import { startHostedHarness } from './app.js'
export { createHarnessApp, startHostedHarness } from './app.js'
export type { HarnessRunner, HarnessTurn, HarnessRequest, HarnessEvent, HarnessResult } from './runner.js'
import { DshRunner } from './dsh.js'
import { loadConfig, loadDotEnv, type RuntimeConfig, handleAction } from '@agentarts/harness-dsh-runtime'
import { loadHostedDshConfig } from './acp-config.js'


/** 解析并发上限 env：非法值（NaN/0/负数/非整数）回退 15，避免限流静默失效 */
export function parseMaxConcurrency(raw: string | undefined): number {
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : 15
}

/** Legacy headless composition retained for existing callers. */
export function createApp(scheduler: Scheduler, maxConcurrency?: number): AgentArtsRuntimeApp {
    const limit = maxConcurrency ?? parseMaxConcurrency(process.env.AGENTRUN_MAX_CONCURRENCY)
    const app = new AgentArtsRuntimeApp({ maxConcurrency: limit })
    app.entrypoint(createInvocationHandler(scheduler))
    app.websocket(createWsHandler(scheduler, app, normalizeRequest))
    registerProtocolFaces(app, scheduler, new TaskRegistry())
    return app
}

export function createDefaultApp(config: RuntimeConfig) {
    const scheduler = new Scheduler({ launchSpec: buildLaunchSpec })
    const app = createApp(scheduler, config.maxConcurrency)
    app.run()
}

export async function startAdapter() {
    loadDotEnv(process.env.DSH_ENV_FILE)
    const runtimeType = process.env.AGENT_RUNTIME_TYPE || 'DSH'
    if (runtimeType === 'DSH') {
        const config = await loadHostedDshConfig()
        const dsh = new DshRunner(config)
        startHostedHarness(dsh, config, (action, body, context) => handleAction(dsh.runtime, action, body, context))
    } else {
        if (runtimeType !== 'DSH_HEADLESS') {
            throw new Error('Unsupported harness type: ' + runtimeType)
        }
        createDefaultApp(loadConfig())
    }
}

// 仅直接运行时启动服务；被测试导入时不启动
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await startAdapter()
}

import { AgentArtsRuntimeApp } from '@huaweicloud/agentarts-sdk'
import { createWsHandler } from '@agentarts/harness-dsh-adapter/handlers/ws.js'
import { registerProtocolFaces } from '@agentarts/harness-dsh-adapter/handlers/register.js'
import { TaskRegistry } from '@agentarts/harness-dsh-adapter/handlers/a2a.js'

import { createInvocationHandler } from './invocation-handler.js'
import { AcpRuntime } from './runtime.js'
import { AcpScheduler } from './scheduler.js'
import type { RuntimeConfig } from './types.js'

export interface RuntimeAppOptions {
    maxConcurrency?: number
    debug?: boolean
    eager?: boolean
}

/**
 * Compose the AgentArts runtime surface. The upper protocol handlers
 * (`/ws`, A2A, AG-UI, frames) come from the adapter package; the runtime only
 * supplies `/invocations` (SSE/token aware) and the ACP execution scheduler.
 */
export function createRuntimeApp(
    runtime: AcpRuntime,
    options: RuntimeAppOptions = {},
): AgentArtsRuntimeApp {
    const app = new AgentArtsRuntimeApp({
        maxConcurrency: options.maxConcurrency ?? runtime.config.maxConcurrency,
        debug: options.debug ?? false,
        lifespan: {
            onStartup: async () => {
                if (options.eager === true) await runtime.start()
            },
            onShutdown: async () => {
                await runtime.dispose()
            },
        },
    })

    const scheduler = new AcpScheduler(runtime)
    app.entrypoint(createInvocationHandler(runtime))
    app.websocket(createWsHandler(scheduler))
    registerProtocolFaces(app, scheduler, new TaskRegistry())
    return app
}

export function configFromRuntime(config: RuntimeConfig): RuntimeConfig {
    return config
}

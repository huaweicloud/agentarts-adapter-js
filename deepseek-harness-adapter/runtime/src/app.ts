import { AgentArtsRuntimeApp } from '@huaweicloud/agentarts-sdk'

import { createInvocationHandler } from './invocation-handler.js'
import { AcpRuntime } from './runtime.js'

export interface RuntimeAppOptions {
    maxConcurrency?: number
    debug?: boolean
    eager?: boolean
}

/**
 * Standalone AgentArts runtime app: `/invocations` supports SSE token frames
 * and `stream:false` JSON. No changes are required in the adapter package.
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
    app.entrypoint(createInvocationHandler(runtime))
    return app
}

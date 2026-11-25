import { createRuntimeApp } from './app.js'
import { AcpRuntime } from './runtime.js'
import { RuntimeConfig } from './types.js'

export function createDshApp(config: RuntimeConfig): void {
    const runtime = new AcpRuntime(config)
    const app = createRuntimeApp(runtime, {
        maxConcurrency: config.maxConcurrency,
    })
    const server = app.run(config.host ?? undefined, config.port)
    server.on('listening', () => {
        console.info(
            `[dsh-acp-runtime] listening on ${config.host ?? '127.0.0.1'}:${config.port}`,
        )
    })

    let stopping = false
    const shutdown = async (signal: string): Promise<void> => {
        if (stopping) return
        stopping = true
        console.info(`[dsh-acp-runtime] ${signal}, shutting down`)
        server.close(() => undefined)
        await runtime.dispose()
        process.exit(0)
    }
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

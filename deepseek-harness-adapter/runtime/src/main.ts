import { pathToFileURL } from 'node:url'

import { createRuntimeApp } from './app.js'
import { loadConfig } from './config.js'
import { AcpRuntime } from './runtime.js'

export function loadDotEnv(file = '.env'): void {
    try {
        // Node >= 20.12; inherited process.env wins over the file.
        ;(process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile?.(file)
    } catch {
        // Missing .env is normal in container deployments.
    }
}

export function main(): void {
    loadDotEnv()
    const config = loadConfig()
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main()
}

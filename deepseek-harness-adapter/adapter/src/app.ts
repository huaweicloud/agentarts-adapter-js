import type { Socket } from 'node:net'
import { EventStoreRunner } from './event-store.js'
import { configureProtocols } from './handlers/sdk-protocols.js'
import { AgentArtsRuntimeApp, FileProtocolStorage, PingStatus } from '@huaweicloud/agentarts-sdk/sdk/runtime'
import type { HarnessRunner } from './runner.js'
import { createWsHandler } from './handlers/ws.js'
import { wsRounds } from './handlers/harness-ws.js'
import { harnessInvocation, decodeRequest } from './handlers/harness-http.js'

export function createHarnessApp(runner: HarnessRunner, maxConcurrency: number, management?: Parameters<typeof harnessInvocation>[1],
    dispose = () => runner.dispose()) {
    let starting = true
    let stopped = false
    let nextAttempt = 0
    async function warmup() {
        starting = true
        try { await runner.start() } finally {
            starting = false
            nextAttempt = Date.now() + 5000
        }
    }
    const app = new AgentArtsRuntimeApp({ maxConcurrency, lifespan: {
        onStartup: warmup,
        async onShutdown() {
            stopped = true
            await dispose()
        },
    } })
    app.ping(() => {
        if (runner.ready) return PingStatus.HEALTHY
        if (stopped) return PingStatus.UNHEALTHY
        if (!starting && Date.now() >= nextAttempt) void warmup().catch(() => {})
        return starting ? PingStatus.INITING : PingStatus.UNHEALTHY
    })
    app.entrypoint(harnessInvocation(runner, management))
    app.websocket(createWsHandler(wsRounds(runner), app, decodeRequest))
    return app
}

interface HostedConfig { maxConcurrency: number; port: number; host: string | null }

/** Production composition shared by all harness implementations. */
export function startHostedHarness(engine: HarnessRunner, config: HostedConfig, management?: Parameters<typeof harnessInvocation>[1]) {
    const dataPath = process.env.AGENTARTS_EVENT_STORAGE_DIR ?? '.agentarts-events'
    const runner = new EventStoreRunner(engine, new FileProtocolStorage(dataPath))
    let resolveClosed!: () => void
    let rejectClosed!: (error: unknown) => void
    const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
    void closed.catch(() => {})
    const app = createHarnessApp(runner, config.maxConcurrency, management, async () => {
        try { await runner.dispose(); resolveClosed() }
        catch (error) { rejectClosed(error); throw error }
    })
    const a2a = configureProtocols(app, runner, config.port)
    const main = app.run(config.host, config.port)
    if (a2a) a2a.server.listen(a2a.port, config.host ?? '127.0.0.1')
    const sockets = new Set<Socket>()
    for (const server of [main, a2a?.server]) {
        server?.on('connection', socket => {
            sockets.add(socket)
            socket.once('close', () => sockets.delete(socket))
        })
    }
    let shutdown: Promise<void> | undefined
    const stop = () => {
        if (!shutdown) {
            shutdown = (async () => {
                process.off('SIGTERM', onSignal)
                process.off('SIGINT', onSignal)
                main.close()
                a2a?.server.close()
                for (const socket of sockets) socket.destroy()
                // The SDK closes its protocol engines before calling lifespan.onShutdown.
                await closed
            })()
        }
        return shutdown
    }
    const onSignal = () => { void stop().catch(error => { console.error(error); process.exitCode = 1 }) }
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
    return { app, main, a2a: a2a?.server, stop }
}

import { pathToFileURL } from 'node:url'
import type { Server } from 'node:http'
import { AgentArtsRuntimeApp, type RuntimeHandler } from '@huaweicloud/agentarts-sdk/sdk/runtime'
import {
    AcpRuntime,
    AcpScheduler,
    createInvocationHandler as createAcpInvocationHandler,
    loadConfig,
} from '@agentarts/harness-dsh-runtime'
import type { SchedulerLike } from './scheduler/types.js'
import { createInvocationHandler } from './handlers/invocations.js'
import { createWsHandler } from './handlers/ws.js'
import { registerProtocolFaces } from './handlers/register.js'
import { TaskRegistry } from './handlers/a2a.js'
import { Scheduler } from './scheduler/index.js'
import { buildLaunchSpec } from './launch-spec.js'

/** 解析并发上限 env：非法值（NaN/0/负数/非整数）回退 15，避免限流静默失效 */
export function parseMaxConcurrency(raw: string | undefined): number {
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : 15
}

/** app 装配选项：执行后端由 scheduler 注入，其余装配参数可由调用方覆盖。 */
export interface CreateAppOptions {
    /** 并发上限；缺省读 `AGENTRUN_MAX_CONCURRENCY`。 */
    maxConcurrency?: number
    /** 覆盖 `/invocations` 处理器（如 ACP runtime 的 SSE 版本）。 */
    entrypoint?: RuntimeHandler
    debug?: boolean
}

/**
 * 装配 SDK app：三端点 + A2A/AG-UI 协议面统一在此注册。
 *
 * 执行后端只通过 `SchedulerLike` 注入：spawn-per-round 与 ACP runtime
 * 复用同一份装配；ACP 后端额外覆盖 `/invocations` 以输出 SSE token 帧。
 */
export function createApp(
    scheduler: SchedulerLike,
    options: CreateAppOptions = {},
): AgentArtsRuntimeApp {
    const limit =
        options.maxConcurrency ?? parseMaxConcurrency(process.env.AGENTRUN_MAX_CONCURRENCY)
    const app = new AgentArtsRuntimeApp({
        maxConcurrency: limit,
        debug: options.debug,
    })
    app.entrypoint(options.entrypoint ?? createInvocationHandler(scheduler))
    app.websocket(createWsHandler(scheduler))
    registerProtocolFaces(app, scheduler, new TaskRegistry())
    return app
}

/** 启动选项：host/port 缺省交给 SDK 按 env 解析。 */
export interface StartAppOptions {
    host?: string | null
    port?: number
    /** SIGINT/SIGTERM 收尾钩子（如 `runtime.dispose()` 释放 ACP 子进程）。 */
    onShutdown?: () => void | Promise<void>
}

/**
 * 启动 HTTP 服务并接管 SIGINT/SIGTERM：先停监听，再跑释放钩子，最后退出。
 * 返回 server，便于测试/编排自行 close。
 */
export function startApp(app: AgentArtsRuntimeApp, options: StartAppOptions = {}): Server {
    const server = app.run(options.host ?? null, options.port)

    server.on('listening', () => {
        const address = server.address()
        const where =
            typeof address === 'object' && address !== null
                ? `${address.address}:${address.port}`
                : `${options.host ?? '127.0.0.1'}:${options.port ?? 0}`
        console.info(`[agentarts] listening on ${where}`)
    })

    let stopping = false
    const shutdown = async (signal: string): Promise<void> => {
        if (stopping) return
        stopping = true
        console.info(`[agentarts] ${signal}, shutting down`)
        server.close(() => undefined)
        await options.onShutdown?.()
        process.exit(0)
    }
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    return server
}

export function loadDotEnv(file = '.env'): void {
    try {
        // Node >= 20.12; inherited process.env wins over the file.
        ; (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile?.(file)
    } catch {
        // Missing .env is normal in container deployments.
    }
}

/**
 * 容器主进程启动：读配置 → 起 ACP runtime → 装配 app → 监听并接管信号。
 *
 * DSH 选择 ACP 长驻后端（runtime 包）；spawn-per-round 后端保留为
 * `createApp(new Scheduler(...))` 的编程入口，后续按 `AGENT_RUNTIME_TYPE` 切换。
 */
export function main(): void {
    loadDotEnv()
    const config = loadConfig()
    if (config.agentRuntimeType === 'DSH') {
        const runtime = new AcpRuntime(config)
        
        startApp(
            createApp(new AcpScheduler(runtime), {
                maxConcurrency: config.maxConcurrency,
                entrypoint: createAcpInvocationHandler(runtime),
            }),
            {
                host: config.host,
                port: config.port,
                onShutdown: () => runtime.dispose(),
            },
        )
    } else {
         const scheduler = new Scheduler({ launchSpec: buildLaunchSpec })
        createApp(scheduler).run()
    }

}

// 直接运行时才启动服务；被测试导入时只导出装配函数
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main()
}

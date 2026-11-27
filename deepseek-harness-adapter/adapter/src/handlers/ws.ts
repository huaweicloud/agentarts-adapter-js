import {
    ConcurrencyLimitError, WebSocketDisconnect, type RequestContext, type WebSocketConnection,
} from '@huaweicloud/agentarts-sdk/sdk/runtime'
import type { RoundHandle } from '../scheduler/run.js'

/**
 * /ws 处理器。非终态帧实时透传，一轮结束不关连接；
 * 对端断开静默退出。与 /ping 分离，长连接不影响探活。
 * 取消：信号在入队前建立，排队期间断开也取消。
 * 终态：执行层暂存 driver 的 final/error，outcome 结算后恰好发一个终态。
 */
export function createWsHandler<T>(scheduler: { run(request: T, signal?: AbortSignal): Promise<RoundHandle> },
    slots: { acquireSlot(): { release(): void } }, decode: (payload: any, fallback?: string | null) => T) {
    return async (ws: WebSocketConnection, ctx: RequestContext): Promise<void> => {
        while (!ws.closed) {
            let payload: any
            try {
                payload = await ws.receiveJson()
            } catch (err) {
                if (err instanceof WebSocketDisconnect) return
                throw err
            }
            let req
            try {
                // sessionId 优先级：payload > 升级请求头 > 生成（与 invocations 对齐）
                req = decode(payload, ctx.sessionId)
            } catch (err) {
                await ws.sendJson({ type: 'error', message: (err as Error).message })
                continue
            }
            if (ws.closed) return
            let lease: { release(): void }
            try {
                lease = slots.acquireSlot()
            } catch (error) {
                if (!(error instanceof ConcurrencyLimitError)) throw error
                await ws.sendJson({ type: 'error', code: error.code, message: error.message })
                continue
            }
            let handle
            try {
                handle = await scheduler.run(req, ws.signal)
                const release = () => lease.release()
                void handle.outcome.then(release, release)
                // 帧流只含非终态帧，实时透传（终态由执行层暂存）
                for await (const frame of handle.frames) {
                    if (ws.closed) break
                    await ws.sendJson(frame)
                }
                const outcome = await handle.outcome
                if (!ws.closed) {
                    if (outcome.ok && outcome.final) {
                        await ws.sendJson(outcome.final)
                    } else if (!outcome.ok) {
                        await ws.sendJson({ type: 'error', message: outcome.error ?? 'round failed' })
                    }
                }
            } catch (error) {
                if (ws.closed || error instanceof WebSocketDisconnect) return
                const code = error instanceof Error && 'code' in error ? error.code : undefined
                await ws.sendJson({ type: 'error', code, message: error instanceof Error ? error.message : String(error) })
            } finally {
                try {
                    handle?.cancel()
                    await handle?.outcome.catch(() => {})
                } finally {
                    lease.release()
                }
            }
        }
    }
}
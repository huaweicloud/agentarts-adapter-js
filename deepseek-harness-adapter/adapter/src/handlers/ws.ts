import {
    WebSocketDisconnect, type RequestContext, type WebSocketConnection,
} from '@huaweicloud/agentarts-sdk/sdk/runtime'
import type { Scheduler } from '../scheduler/index.js'
import { normalizeRequest } from '../request.js'

/**
 * /ws 处理器。非终态帧实时透传，一轮结束不关连接；
 * 对端断开静默退出。与 /ping 分离，长连接不影响探活。
 * 取消：信号在入队前建立，排队期间断开也取消。
 * 终态：执行层暂存 driver 的 final/error，outcome 结算后恰好发一个终态。
 */
export function createWsHandler(scheduler: Scheduler) {
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
                req = normalizeRequest(payload, ctx.sessionId)
            } catch (err) {
                await ws.sendJson({ type: 'error', message: (err as Error).message })
                continue
            }
            if (ws.closed) return
            // 取消信号必须在入队前建立：同会话前一轮占队时，断开发生在排队期间
            const ac = new AbortController()
            const onClose = () => ac.abort()
            ws.raw.once('close', onClose)
            try {
                const handle = await scheduler.run(req, ac.signal)
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
            } finally {
                ws.raw.off('close', onClose)
                ac.abort()   // 幂等：消费端退出即取消仍在执行的轮次
            }
        }
    }
}
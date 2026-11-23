import {
    WebSocketDisconnect, type RequestContext, type WebSocketConnection,
} from '@huaweicloud/agentarts-sdk/sdk/runtime'
import type { Scheduler } from '../scheduler/index.js'
import { normalizeRequest } from '../request.js'

/**
 * A 模块：/ws 处理器（spec §3.3）。帧透传，一轮结束不关连接；
 * 对端断开静默退出。与 /ping 分离，长连接不影响探活。
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
                // sessionId 优先级：payload > 升级请求头 > 生成（BUG-03，与 invocations 对齐）
                req = normalizeRequest(payload, ctx.sessionId)
            } catch (err) {
                await ws.sendJson({ type: 'error', message: (err as Error).message })
                continue
            }
            const handle = await scheduler.run(req)
            for await (const frame of handle.frames) {
                if (ws.closed) break
                await ws.sendJson(frame)
            }
            const outcome = await handle.outcome
            // 子进程失败但没来得及输出 error 帧时补发
            if (!outcome.ok && !ws.closed) {
                await ws.sendJson({ type: 'error', message: outcome.error ?? 'round failed' })
            }
        }
    }
}
import {
    WebSocketDisconnect, type RequestContext, type WebSocketConnection,
} from '@huaweicloud/agentarts-sdk/sdk/runtime'
import type { Frame } from '@agentarts/harness-dsh-shared'
import type { Scheduler } from '../scheduler/index.js'
import { normalizeRequest } from '../request.js'

/**
 * A 模块：/ws 处理器（spec §3.3）。帧透传，一轮结束不关连接；
 * 对端断开静默退出。与 /ping 分离，长连接不影响探活。
 * 取消（BUG-06）：信号在入队前建立，排队期间断开也取消；成功终态延迟到
 * driver flush 且子进程退出后再发，保护收到 final 立即关闭的正常客户端。
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
            if (ws.closed) return
            // 取消信号必须在入队前建立：同会话前一轮占队时，断开发生在排队期间
            const ac = new AbortController()
            const onClose = () => ac.abort()
            ws.raw.once('close', onClose)
            try {
                const handle = await scheduler.run(req, ac.signal)
                let pendingFinal: Frame | null = null
                for await (const frame of handle.frames) {
                    if (ws.closed) break
                    if (frame.type === 'final') {
                        // 扣住 final：等 outcome 确认 flush 完成、进程成功退出后再发
                        pendingFinal = frame
                        continue
                    }
                    await ws.sendJson(frame)
                }
                const outcome = await handle.outcome
                if (!ws.closed) {
                    if (outcome.ok && pendingFinal) {
                        await ws.sendJson(pendingFinal)
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
import { JsonResponse, type RequestContext } from '@huaweicloud/agentarts-sdk/sdk/runtime'
import type { Scheduler } from '../scheduler/index.js'
import { normalizeRequest } from '../request.js'
import { SESSION_HEADER } from '../types.js'

/**
 * A 模块：/invocations 处理器（spec §2.2）。只要 final 帧；
 * 响应头显式携带 sessionId（不依赖 SDK 从请求头回填）。
 */
export function createInvocationHandler(scheduler: Scheduler) {
    return async (payload: any, context?: RequestContext): Promise<JsonResponse> => {
        let req
        try {
            req = normalizeRequest(payload, context?.sessionId)
        } catch (err) {
            return new JsonResponse({ statusCode: 400, content: { error: (err as Error).message } })
        }
        const handle = await scheduler.run(req)
        // 并发排空帧流：只要 final，但必须消费，否则整轮帧无界缓存（BUG-07）
        const drained = (async () => {
            for await (const _frame of handle.frames) { /* 丢弃非 final 帧 */ }
        })()
        const outcome = await handle.outcome
        await drained
        const headers = { [SESSION_HEADER]: req.sessionId }
        if (!outcome.ok || !outcome.final) {
            return new JsonResponse({
                statusCode: 500,
                content: { error: outcome.error ?? 'no final frame' },
                headers,
            })
        }
        return new JsonResponse({
            content: { result: outcome.final.text, sessionId: req.sessionId },
            headers,
        })
    }
}
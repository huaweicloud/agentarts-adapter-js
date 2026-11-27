import { JsonResponse, type RequestContext } from '@huaweicloud/agentarts-sdk/sdk/runtime'
import type { Scheduler } from '../scheduler/index.js'
import { normalizeRequest } from '../request.js'
import { SESSION_HEADER } from '../types.js'

/**
 * /invocations 处理器。只要 final 帧；
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
        const headers = { [SESSION_HEADER]: req.sessionId }
        let outcome
        try {
            const handle = await scheduler.run(req, context?.signal)
            // 只返回 final，排空中间帧以释放帧缓冲。
            const drained = (async () => {
                for await (const _frame of handle.frames) { /* 排空中间帧 */ }
            })()
            const [result] = await Promise.all([handle.outcome, drained])
            outcome = result
        } catch (error) {
            return new JsonResponse({
                statusCode: 500,
                content: { error: error instanceof Error ? error.message : String(error) },
                headers,
            })
        }
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
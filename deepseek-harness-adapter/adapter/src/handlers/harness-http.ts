import { randomUUID } from 'node:crypto'
import { JsonResponse, StreamingResponse, type RequestContext } from '@huaweicloud/agentarts-sdk/sdk/runtime'
import { SESSION_HEADER } from '../types.js'
import type { HarnessRequest, HarnessRunner } from '../runner.js'

export function decodeRequest(body: Record<string, unknown>, fallback?: string | null): HarnessRequest {
    const prompt = [body?.prompt, body?.input, body?.message].find(v => typeof v === 'string' && v.length > 0)
    if (typeof prompt !== 'string') throw Object.assign(new Error('prompt is required'), { code: 'invalid_request', statusCode: 400 })
    return {
        prompt,
        sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : fallback || randomUUID(),
        stream: body.stream !== false,
        eventId: typeof body.eventId === 'string' && body.eventId ? body.eventId : undefined,
        attempt: typeof body.attempt === 'number' && Number.isSafeInteger(body.attempt) && body.attempt > 0 ? body.attempt : 1,
        options: body,
    }
}

type ActionHandler = (action: string, body: Record<string, unknown>, context?: RequestContext) => Promise<JsonResponse>

export function harnessInvocation(runner: HarnessRunner, management?: ActionHandler) {
    return async (payload: unknown, context?: RequestContext) => {
        const body = (payload ?? {}) as Record<string, unknown>
        const session = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : context?.sessionId
        const headers: Record<string, string> = session ? { [SESSION_HEADER]: session } : {}
        const action = String(body.action ?? 'prompt').toLowerCase()
        try {
            if (!['prompt', 'invoke', 'chat', 'run'].includes(action)) {
                if (management) return await management(action, body, context)
                throw Object.assign(new Error('unsupported action'), { code: 'invalid_action', statusCode: 400 })
            }
            const request = decodeRequest(body, session)
            headers[SESSION_HEADER] = request.sessionId
            const turn = await runner.runTurn(request, context?.signal)
            if (!request.stream) {
                const { ok, error, ...result } = await turn.result
                return new JsonResponse({ headers, statusCode: ok ? 200 : error?.statusCode ?? 502,
                    content: ok ? { ...result, result: result.output } : { error } })
            }
            const stream = async function* () {
                try {
                    for await (const event of turn.events) yield sse(event)
                    const { ok, output, stopReason, error, ...details } = await turn.result
                    yield sse(ok ? { ...details, type: 'run_finished', output, stopReason } : { ...error, type: 'error' })
                } catch (error) {
                    yield sse({ type: 'error', code: 'round_failed', message: error instanceof Error ? error.message : String(error) })
                } finally {
                    turn.cancel()
                    await turn.result.catch(() => {})
                }
            }
            return new StreamingResponse(stream(), { headers, mediaType: 'text/event-stream' })
        } catch (cause) {
            const error = cause as { statusCode?: number; code?: string; message?: string }
            return new JsonResponse({ headers, statusCode: error.statusCode ?? (error.code === 'CAPACITY' ? 503 : 500),
                content: { error: { code: error.code ?? 'internal_error', message: error.message ?? String(cause) } } })
        }
    }
}

function sse(event: unknown): string {
    return 'data: ' + JSON.stringify(event) + '\n\n'
}

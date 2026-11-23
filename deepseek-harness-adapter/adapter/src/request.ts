import { randomUUID } from 'node:crypto'
import type { RoundRequest } from '@agentarts/harness-dsh-shared'

function asString(v: unknown): string | null {
    return typeof v === 'string' && v !== '' ? v : null
}

/** payload → 四元组。sessionId 优先级：payload > 请求头 > 生成（spec §2.2）。 */
export function normalizeRequest(payload: any, headerSessionId?: string | null): RoundRequest {
    if (typeof payload?.prompt !== 'string' || payload.prompt === '') {
        throw new Error('prompt is required')
    }
    const attempt = payload.attempt
    return {
        sessionId: asString(payload.sessionId) ?? asString(headerSessionId) ?? randomUUID(),
        prompt: payload.prompt,
        eventId: asString(payload.eventId) ?? randomUUID(),
        attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
    }
}
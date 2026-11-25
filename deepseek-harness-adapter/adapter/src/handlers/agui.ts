import { randomUUID } from 'node:crypto'
import type { Frame } from '@agentarts/harness-dsh-shared'
import type { SchedulerLike } from '../scheduler/types.js'

/**
 * AG-UI run 输入；用户答复 = 同 sessionId 的新 run，无特殊分支。
 * signal 按 SDK 对 run 的取消约定透传（待 SDK 接口就绪后接线）；退订不取消。
 */
export interface AguiRunInput {
    sessionId: string
    prompt: string
    eventId?: string
    attempt?: number
    signal?: AbortSignal
}

/** AG-UI 处理器。帧 → AG-UI 事件翻译在 SDK，这里只产帧流。 */
export function createAguiHandler(scheduler: SchedulerLike) {
    return async function* (input: AguiRunInput): AsyncIterable<Frame> {
        const handle = await scheduler.run({
            sessionId: input.sessionId,
            prompt: input.prompt,
            eventId: input.eventId || randomUUID(),
            attempt: input.attempt ?? 1,
        }, input.signal)
        yield* handle.frames
        const outcome = await handle.outcome
        // 唯一终态来自执行层 outcome：成功发 final，失败发 error
        if (outcome.ok && outcome.final) {
            yield outcome.final
        } else if (!outcome.ok) {
            yield { type: 'error', message: outcome.error ?? 'round failed' }
        }
    }
}
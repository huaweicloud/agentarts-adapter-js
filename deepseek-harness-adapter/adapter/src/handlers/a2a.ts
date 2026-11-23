import { randomUUID } from 'node:crypto'
import type { Frame } from '@agentarts/harness-dsh-shared'
import type { Scheduler } from '../scheduler/index.js'

/** 归一化 A2A 输入（SDK 侧负责把 A2A message 适配成此形状，契约待确认，spec §7 第 3 项） */
export interface A2ARequest {
    taskId: string
    sessionId: string
    prompt: string
    eventId: string
    attempt: number
}

/** taskId ↔ sessionId 映射（spec §2.3）；执行期间绑定，本轮结束解绑 */
export class TaskRegistry {
    private map = new Map<string, string>()
    bind(taskId: string, sessionId: string): void { this.map.set(taskId, sessionId) }
    lookup(taskId: string): string | undefined { return this.map.get(taskId) }
    unbind(taskId: string): void { this.map.delete(taskId) }
}

/**
 * A 模块：A2A 处理器。产出帧流，task 状态迁移/产物翻译在 SDK 的 A2A 面。
 * question 帧由 SDK 译为"需要输入"；用户答复经同一 sessionId 的下一轮进来。
 */
export function createA2AHandler(scheduler: Scheduler, registry: TaskRegistry) {
    return async function* (input: A2ARequest): AsyncIterable<Frame> {
        registry.bind(input.taskId, input.sessionId)
        try {
            const handle = await scheduler.run({
                sessionId: input.sessionId,
                prompt: input.prompt,
                eventId: input.eventId || randomUUID(),
                attempt: input.attempt ?? 1,
            })
            yield* handle.frames
            const outcome = await handle.outcome
            if (!outcome.ok) {
                yield { type: 'error', message: outcome.error ?? 'round failed' }
            }
        } finally {
            registry.unbind(input.taskId)
        }
    }
}
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

/** taskId ↔ sessionId 映射（spec §2.3）；执行期间绑定，本轮结束凭所有权令牌解绑 */
export class TaskRegistry {
    private map = new Map<string, {
        sessionId: string; owner: symbol; controller: AbortController
    }>()

    /** 绑定并返回所有权令牌；同 taskId 重试轮覆盖绑定，旧轮令牌随之失效（BUG-05） */
    bind(taskId: string, sessionId: string, controller: AbortController): symbol {
        const owner = Symbol(taskId)
        this.map.set(taskId, { sessionId, owner, controller })
        return owner
    }

    lookup(taskId: string): string | undefined { return this.map.get(taskId)?.sessionId }

    /** 仅当令牌匹配当前绑定才删除——旧轮不得误删仍在执行的新轮绑定 */
    unbind(taskId: string, owner: symbol): void {
        if (this.map.get(taskId)?.owner === owner) this.map.delete(taskId)
    }

    /** 显式 CancelTask 入口：abort 当前绑定轮次（SDK A2A 面交付后接线，BUG-06） */
    cancel(taskId: string): boolean {
        const entry = this.map.get(taskId)
        if (!entry) return false
        entry.controller.abort()
        return true
    }
}

/**
 * A 模块：A2A 处理器。产出帧流，task 状态迁移/产物翻译在 SDK 的 A2A 面。
 * 任务生命周期独立于订阅流：退订不取消任务，取消由显式 CancelTask
 * （registry.cancel）触发（BUG-06）。
 */
export function createA2AHandler(scheduler: Scheduler, registry: TaskRegistry) {
    return async function* (input: A2ARequest): AsyncIterable<Frame> {
        const controller = new AbortController()
        const owner = registry.bind(input.taskId, input.sessionId, controller)
        try {
            const handle = await scheduler.run({
                sessionId: input.sessionId,
                prompt: input.prompt,
                eventId: input.eventId || randomUUID(),
                attempt: input.attempt ?? 1,
            }, controller.signal)
            yield* handle.frames
            const outcome = await handle.outcome
            // 唯一终态来自执行层 outcome（BUG-08）：成功发 final，失败发 error
            if (outcome.ok && outcome.final) {
                yield outcome.final
            } else if (!outcome.ok) {
                yield { type: 'error', message: outcome.error ?? 'round failed' }
            }
        } finally {
            // 只解绑，不 abort：退订不等于取消任务
            registry.unbind(input.taskId, owner)
        }
    }
}
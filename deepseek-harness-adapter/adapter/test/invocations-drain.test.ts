import { describe, expect, it } from 'vitest'
import type { RoundHandle } from '../src/scheduler/run.js'
import type { Scheduler } from '../src/scheduler/index.js'
import { createInvocationHandler } from '../src/handlers/invocations.js'

describe('invocations 帧流消费', () => {
    it('排空帧流，不无界缓存（10000 帧长输出）', async () => {
        let yielded = 0
        const finalFrame = {
            type: 'final', text: 'ok', reason: { kind: 'completed' }, sessionId: 's',
        } as const
        const handle: RoundHandle = {
            frames: (async function* () {
                for (let i = 0; i < 10000; i++) {
                    yielded++
                    yield { type: 'delta', kind: 'text', text: `t${i}`, attemptId: 'a', revision: i }
                }
                yielded++
                yield finalFrame
            })(),
            outcome: Promise.resolve({ ok: true, final: finalFrame, error: null, exitCode: 0 }),
            cancel: () => {},
        }
        const scheduler = { run: async () => handle } as unknown as Scheduler
        const res = await createInvocationHandler(scheduler)(
            { sessionId: 's', prompt: 'p', eventId: 'e', attempt: 1 })
        expect(res.statusCode).toBe(200)
        expect(yielded).toBe(10001)   // 全部帧被消费，而非堆在通道里
    })
})
import { describe, expect, it } from 'vitest'
import type { Frame } from '@agentarts/harness-dsh-shared'
import type { RoundHandle, RoundOutcome } from '../src/scheduler/run.js'
import type { Scheduler } from '../src/scheduler/index.js'
import { TaskRegistry, createA2AHandler } from '../src/handlers/a2a.js'
import { createAguiHandler } from '../src/handlers/agui.js'
import { collect } from './helpers.js'

const finalFrame: Frame = {
    type: 'final', text: 'ok', reason: { kind: 'completed' }, sessionId: 's1',
}

/** 假 scheduler：canned 帧流 + 可控 outcome */
function fakeScheduler(frames: Frame[], ok: boolean, error: string | null = null): Scheduler {
    const handle: RoundHandle = {
        frames: (async function* () { yield* frames })(),
        outcome: Promise.resolve({
            ok, final: ok ? (finalFrame as any) : null, error, exitCode: ok ? 0 : 1,
        }),
        cancel: () => {},
    }
    return { run: async () => handle } as unknown as Scheduler
}

const a2aInput = { taskId: 't1', sessionId: 's1', prompt: 'p', eventId: 'e1', attempt: 1 }

describe('createA2AHandler', () => {
    it('执行期间绑定 taskId↔sessionId，结束后解绑，终态来自 outcome', async () => {
        const registry = new TaskRegistry()
        let boundDuringRun: string | undefined
        const scheduler = {
            run: async () => {
                boundDuringRun = registry.lookup('t1')
                return fakeScheduler([], true).run({} as any)
            },
        } as unknown as Scheduler
        const frames = await collect(createA2AHandler(scheduler, registry)(a2aInput))
        expect(boundDuringRun).toBe('s1')
        expect(registry.lookup('t1')).toBeUndefined()
        expect(frames).toEqual([finalFrame])
    })

    it('失败轮输出唯一 error 终态', async () => {
        const registry = new TaskRegistry()
        const frames = await collect(
            createA2AHandler(fakeScheduler([], false, 'boom'), registry)(a2aInput))
        expect(frames).toEqual([{ type: 'error', message: 'boom' }])
        expect(registry.lookup('t1')).toBeUndefined()
    })

    it('非终态帧透传 + 恰好一个终态', async () => {
        const registry = new TaskRegistry()
        const delta: Frame = { type: 'delta', kind: 'text', text: 't', attemptId: 'a', revision: 0 }
        const frames = await collect(
            createA2AHandler(fakeScheduler([delta], true), registry)(a2aInput))
        expect(frames).toEqual([delta, finalFrame])
    })
})

describe('createAguiHandler', () => {
    it('透传非终态帧 + 唯一终态；eventId/attempt 缺省自动生成', async () => {
        let seen: any = null
        const delta: Frame = { type: 'delta', kind: 'text', text: 't', attemptId: 'a', revision: 0 }
        const scheduler = {
            run: async (req: any) => {
                seen = req
                return fakeScheduler([delta], true).run(req)
            },
        } as unknown as Scheduler
        const frames = await collect(createAguiHandler(scheduler)({ sessionId: 's1', prompt: 'p' }))
        expect(frames).toEqual([delta, finalFrame])
        expect(seen.sessionId).toBe('s1')
        expect(seen.eventId).toMatch(/[0-9a-f-]{36}/)
        expect(seen.attempt).toBe(1)
    })

    it('失败轮输出唯一 error 终态', async () => {
        const frames = await collect(
            createAguiHandler(fakeScheduler([], false, 'down'))({ sessionId: 's', prompt: 'p' }))
        expect(frames).toEqual([{ type: 'error', message: 'down' }])
    })
})

describe('TaskRegistry', () => {
    it('bind/lookup/unbind', () => {
        const r = new TaskRegistry()
        const owner = r.bind('t', 's', new AbortController())
        expect(r.lookup('t')).toBe('s')
        r.unbind('t', owner)
        expect(r.lookup('t')).toBeUndefined()
    })

    it('所有权校验：旧轮令牌删不掉新轮绑定', () => {
        const r = new TaskRegistry()
        const owner1 = r.bind('t', 's1', new AbortController())
        const owner2 = r.bind('t', 's2', new AbortController())   // 重试轮覆盖绑定
        r.unbind('t', owner1)              // 旧轮先结束，不得误删新绑定
        expect(r.lookup('t')).toBe('s2')
        r.unbind('t', owner2)
        expect(r.lookup('t')).toBeUndefined()
    })
})

describe('A2A 取消语义', () => {
    it('退订不取消任务；显式 registry.cancel 才 abort 轮次信号', async () => {
        const registry = new TaskRegistry()
        let seenSignal: AbortSignal | undefined
        let resolveOutcome!: (o: RoundOutcome) => void
        const hangHandle: RoundHandle = {
            frames: (async function* () {})(),
            outcome: new Promise<RoundOutcome>((r) => { resolveOutcome = r }),
            cancel: () => {},
        }
        const scheduler = {
            run: async (_req: any, signal?: AbortSignal) => {
                seenSignal = signal
                return hangHandle
            },
        } as unknown as Scheduler
        const gen = createA2AHandler(scheduler, registry)(a2aInput)
        // 帧流为空，next() 挂在 await outcome 上；退订的 finally 要等生产端解除才执行
        const pending = gen.next()
        const returned = gen.return()
        expect(seenSignal!.aborted).toBe(false)      // 退订不取消任务
        expect(registry.cancel('t1')).toBe(true)     // 显式 CancelTask 入口
        expect(seenSignal!.aborted).toBe(true)
        resolveOutcome({
            ok: false, final: null, error: 'round cancelled by consumer', exitCode: null,
        })
        await returned
        await pending
        expect(registry.lookup('t1')).toBeUndefined()
    })
})
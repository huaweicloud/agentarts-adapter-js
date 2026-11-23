import { describe, expect, it } from 'vitest'
import type { Frame } from '@agentarts/harness-dsh-shared'
import type { RoundHandle } from '../src/scheduler/run.js'
import type { Scheduler } from '../src/scheduler/index.js'
import { TaskRegistry, createA2AHandler } from '../src/handlers/a2a.js'
import { createAguiHandler } from '../src/handlers/agui.js'

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
    }
    return { run: async () => handle } as unknown as Scheduler
}

async function collect(it: AsyncIterable<Frame>): Promise<Frame[]> {
    const out: Frame[] = []
    for await (const f of it) out.push(f)
    return out
}

const a2aInput = { taskId: 't1', sessionId: 's1', prompt: 'p', eventId: 'e1', attempt: 1 }

describe('createA2AHandler', () => {
    it('执行期间绑定 taskId↔sessionId，结束后解绑，帧透传', async () => {
        const registry = new TaskRegistry()
        let boundDuringRun: string | undefined
        const scheduler = {
            run: async () => {
                boundDuringRun = registry.lookup('t1')
                return fakeScheduler([finalFrame], true).run({} as any)
            },
        } as unknown as Scheduler
        const frames = await collect(createA2AHandler(scheduler, registry)(a2aInput))
        expect(boundDuringRun).toBe('s1')
        expect(registry.lookup('t1')).toBeUndefined()
        expect(frames).toEqual([finalFrame])
    })

    it('失败轮补发 error 帧', async () => {
        const registry = new TaskRegistry()
        const frames = await collect(
            createA2AHandler(fakeScheduler([], false, 'boom'), registry)(a2aInput))
        expect(frames).toEqual([{ type: 'error', message: 'boom' }])
        expect(registry.lookup('t1')).toBeUndefined()
    })
})

describe('createAguiHandler', () => {
    it('透传帧流；eventId/attempt 缺省自动生成', async () => {
        let seen: any = null
        const scheduler = {
            run: async (req: any) => {
                seen = req
                return fakeScheduler([finalFrame], true).run(req)
            },
        } as unknown as Scheduler
        const frames = await collect(createAguiHandler(scheduler)({ sessionId: 's1', prompt: 'p' }))
        expect(frames).toEqual([finalFrame])
        expect(seen.sessionId).toBe('s1')
        expect(seen.eventId).toMatch(/[0-9a-f-]{36}/)
        expect(seen.attempt).toBe(1)
    })

    it('失败轮补发 error 帧', async () => {
        const frames = await collect(
            createAguiHandler(fakeScheduler([], false, 'down'))({ sessionId: 's', prompt: 'p' }))
        expect(frames).toEqual([{ type: 'error', message: 'down' }])
    })
})

describe('TaskRegistry', () => {
    it('bind/lookup/unbind', () => {
        const r = new TaskRegistry()
        r.bind('t', 's')
        expect(r.lookup('t')).toBe('s')
        r.unbind('t')
        expect(r.lookup('t')).toBeUndefined()
    })
})
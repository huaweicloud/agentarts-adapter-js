import { describe, expect, it } from 'vitest'
import type { Frame } from '@agentarts/harness-dsh-shared'
import { createFrameChannel } from '../src/scheduler/frame-channel.js'

const delta = (i: number): Frame => ({
    type: 'delta', kind: 'text', text: `t${i}`, attemptId: 'a', revision: i,
})

describe('帧通道字节水位背压（BUG-11）', () => {
    it('只 push 不消费：超高水位触发 onPause，且只触发一次', () => {
        const calls: string[] = []
        const ch = createFrameChannel({
            onPause: () => calls.push('pause'), onResume: () => calls.push('resume'),
        }, 100, 50)
        ch.push(delta(1), 60)
        expect(calls).toEqual([])
        ch.push(delta(2), 60)   // 120 >= 100 → pause
        expect(calls).toEqual(['pause'])
        ch.push(delta(3), 60)   // 已暂停，不重复触发
        expect(calls).toEqual(['pause'])
    })

    it('消费回落到低水位触发 onResume，帧不丢', async () => {
        const calls: string[] = []
        const ch = createFrameChannel({
            onPause: () => calls.push('pause'), onResume: () => calls.push('resume'),
        }, 100, 50)
        ch.push(delta(1), 60); ch.push(delta(2), 60); ch.push(delta(3), 60)
        ch.end()
        const out: Frame[] = []
        for await (const f of ch.frames) out.push(f)
        expect(out).toHaveLength(3)
        expect(calls).toEqual(['pause', 'resume'])
    })

    it('无钩子默认不抛错', async () => {
        const ch = createFrameChannel()
        ch.push(delta(1), 10)
        ch.end()
        const out: Frame[] = []
        for await (const f of ch.frames) out.push(f)
        expect(out).toHaveLength(1)
    })
})
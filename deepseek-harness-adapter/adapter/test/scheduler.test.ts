import { describe, expect, it, vi } from 'vitest'
import type { RoundRequest } from '@agentarts/harness-dsh-shared'
import { Scheduler } from '../src/scheduler/index.js'
import { fakeSpec as makeSpec } from './helpers.js'

const req = (sessionId: string, prompt = 'hi'): RoundRequest => ({
    sessionId, prompt, eventId: `e-${prompt}`, attempt: 1,
})
const fakeSpec = (env: Record<string, string> = {}) => makeSpec('normal', env)

describe('Scheduler', () => {
    it('跑通一轮并把 recall 结果传给 launchSpec', async () => {
        const launchSpec = vi.fn((r: RoundRequest, recall: string) =>
            fakeSpec({ AGENTRUN_RECALL_RESULT: recall, AGENTRUN_DSH_SESSION_ID: r.sessionId }))
        const scheduler = new Scheduler({ launchSpec, recall: async () => '记忆片段' })
        const handle = await scheduler.run(req('s1'))
        const outcome = await handle.outcome
        expect(outcome.ok).toBe(true)
        expect(launchSpec).toHaveBeenCalledWith(req('s1'), '记忆片段')
    })

    it('recall 缺省或抛错都降级为空串，不阻塞执行', async () => {
        const s1 = new Scheduler({ launchSpec: () => fakeSpec() })
        expect((await s1.run(req('s1'))).outcome).toBeDefined()
        const s2 = new Scheduler({
            launchSpec: () => fakeSpec(),
            recall: async () => { throw new Error('memory down') },
        })
        const outcome = await (await s2.run(req('s2'))).outcome
        expect(outcome.ok).toBe(true)
    })

    it('同 sessionId 两轮串行：第二轮帧在第一轮结束后才开始', async () => {
        const scheduler = new Scheduler({ launchSpec: () => fakeSpec() })
        const h1 = await scheduler.run(req('s1', 'first'))
        const h2Promise = scheduler.run(req('s1', 'second'))
        // h1 未结束时 h2 不应拿到 handle（仍在排队）
        let h2Resolved = false
        void h2Promise.then(() => { h2Resolved = true })
        await new Promise((r) => setTimeout(r, 20))
        expect(h2Resolved).toBe(false)
        const o1 = await h1.outcome
        const h2 = await h2Promise
        const o2 = await h2.outcome
        expect(o1.ok && o2.ok).toBe(true)
        expect(o1.final?.text).toBe('echo:first')
        expect(o2.final?.text).toBe('echo:second')
    })
})
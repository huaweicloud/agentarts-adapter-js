import { afterEach, describe, expect, it } from 'vitest'
import type { LaunchSpec } from '@agentarts/harness-dsh-shared'
import { createApp, parseMaxConcurrency } from '../src/main.js'
import { Scheduler } from '../src/scheduler/index.js'

describe('parseMaxConcurrency（BUG-04 回归）', () => {
    it('非法值一律回退 15', () => {
        for (const raw of [undefined, '', 'abc', '0', '-2', '3.5']) {
            expect(parseMaxConcurrency(raw)).toBe(15)
        }
    })

    it('合法正整数通过', () => {
        expect(parseMaxConcurrency('3')).toBe(3)
        expect(parseMaxConcurrency('1')).toBe(1)
    })
})

describe('createApp 并发配置', () => {
    const spec: LaunchSpec = { command: 'x', args: [], env: {}, encodeStdin: (t) => t }
    const scheduler = new Scheduler({ launchSpec: () => spec })
    afterEach(() => { delete process.env.AGENTRUN_MAX_CONCURRENCY })

    it('env 非法时 app.maxConcurrency 回退 15', () => {
        process.env.AGENTRUN_MAX_CONCURRENCY = 'abc'
        expect(createApp(scheduler).maxConcurrency).toBe(15)
    })

    it('显式参数优先于 env', () => {
        process.env.AGENTRUN_MAX_CONCURRENCY = '7'
        expect(createApp(scheduler, 2).maxConcurrency).toBe(2)
    })
})
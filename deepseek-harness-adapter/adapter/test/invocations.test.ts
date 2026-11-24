import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Scheduler } from '../src/scheduler/index.js'
import { createApp } from '../src/main.js'
import { SESSION_HEADER } from '../src/types.js'
import { fakeSpec, listen } from './helpers.js'

let server: Server | null = null
async function start(maxConcurrency?: number): Promise<string> {
    const scheduler = new Scheduler({ launchSpec: () => fakeSpec() })
    const started = await listen(createApp(scheduler, maxConcurrency))
    server = started.server
    return `http://${started.base}`
}
afterEach(async () => {
    // server 为 null 时直接跳过（BUG-09：可选链短路会使 Promise 永不 resolve）
    if (server) await new Promise((r) => server!.close(r))
    server = null
})

describe('POST /invocations（真 SDK app + 假子进程）', () => {
    it('正常一轮：返回 {result, sessionId} 与 session 响应头', async () => {
        const base = await start()
        const res = await fetch(`${base}/invocations`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: 's1', prompt: 'hello', eventId: 'e1', attempt: 1 }),
        })
        const body = await res.text()
        expect(res.status, `响应体: ${body}`).toBe(200)
        expect(res.headers.get(SESSION_HEADER)).toBe('s1')
        expect(JSON.parse(body)).toEqual({ result: 'echo:hello', sessionId: 's1' })
    })

    it('子进程失败：500 且带错误信息', async () => {
        const scheduler = new Scheduler({ launchSpec: () => fakeSpec('fail') })
        const started = await listen(createApp(scheduler))
        server = started.server
        const base = `http://${started.base}`
        const res = await fetch(`${base}/invocations`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'x' }),
        })
        expect(res.status).toBe(500)
        expect((await res.json()).error).toContain('model exploded')
    })

    it('prompt 缺失：400', async () => {
        const base = await start()
        const res = await fetch(`${base}/invocations`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: 's' }),
        })
        expect(res.status).toBe(400)
    })

    it('满载 503（maxConcurrency=1，SDK 行为）', async () => {
        const scheduler = new Scheduler({ launchSpec: () => fakeSpec('slow') })
        const started = await listen(createApp(scheduler, 1))
        server = started.server
        const base = `http://${started.base}`
        const body = JSON.stringify({ prompt: 'x' })
        const headers = { 'content-type': 'application/json' }
        const [r1, r2] = await Promise.all([
            fetch(`${base}/invocations`, { method: 'POST', headers, body }),
            fetch(`${base}/invocations`, { method: 'POST', headers, body }),
        ])
        expect([r1.status, r2.status].sort()).toEqual([200, 503])
    })

    it('GET /ping 返回 Healthy（SDK 默认行为）', async () => {
        const base = await start()
        const res = await fetch(`${base}/ping`)
        expect(res.status).toBe(200)
        expect(await res.text()).toContain('Healthy')
    })
})

describe('afterEach 钩子（BUG-09 回归）', () => {
    it('无 server 的单元测试不挂起钩子', () => {
        expect(server).toBeNull()
    })
})
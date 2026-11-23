import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { LaunchSpec } from '@agentarts/harness-dsh-shared'
import { Scheduler } from '../src/scheduler/index.js'
import { createApp } from '../src/main.js'
import { SESSION_HEADER } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))
const fakeSpec = (mode = 'normal'): LaunchSpec => ({
    command: process.execPath,
    args: [fixture],
    env: { ...process.env, AGENTRUN_TEST_MODE: mode } as Record<string, string>,
    encodeStdin: (t) => t,
})

let server: Server | null = null
async function start(maxConcurrency?: number): Promise<string> {
    const scheduler = new Scheduler({ launchSpec: () => fakeSpec() })
    const app = createApp(scheduler, maxConcurrency)
    server = app.run('127.0.0.1', 0)
    await new Promise((r) => server!.once('listening', r))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}
afterEach(async () => {
    await new Promise((r) => server?.close(r))
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
        expect(res.status).toBe(200)
        expect(res.headers.get(SESSION_HEADER)).toBe('s1')
        expect(await res.json()).toEqual({ result: 'echo:hello', sessionId: 's1' })
    })

    it('子进程失败：500 且带错误信息', async () => {
        const scheduler = new Scheduler({ launchSpec: () => fakeSpec('fail') })
        const app = createApp(scheduler)
        server = app.run('127.0.0.1', 0)
        await new Promise((r) => server!.once('listening', r))
        const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
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
        const app = createApp(scheduler, 1)
        server = app.run('127.0.0.1', 0)
        await new Promise((r) => server!.once('listening', r))
        const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
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
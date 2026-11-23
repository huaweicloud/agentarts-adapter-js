import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import type { LaunchSpec } from '@agentarts/harness-dsh-shared'
import { Scheduler } from '../src/scheduler/index.js'
import { createApp } from '../src/main.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))
const fakeSpec = (mode = 'normal'): LaunchSpec => ({
    command: process.execPath,
    args: [fixture],
    env: { ...process.env, AGENTRUN_TEST_MODE: mode } as Record<string, string>,
    encodeStdin: (t) => t,
})

let server: Server | null = null
async function start(mode = 'normal'): Promise<string> {
    const app = createApp(new Scheduler({ launchSpec: () => fakeSpec(mode) }))
    server = app.run('127.0.0.1', 0)
    await new Promise((r) => server!.once('listening', r))
    return `ws://127.0.0.1:${(server!.address() as AddressInfo).port}/ws`
}
afterEach(async () => {
    await new Promise((r) => server?.close(r))
    server = null
})

/** 收帧直到 final/error，或超时 */
function collectRound(ws: WebSocket): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const frames: any[] = []
        const timer = setTimeout(() => reject(new Error('ws round timeout')), 10000)
        ws.on('message', (data) => {
            const f = JSON.parse(String(data))
            frames.push(f)
            if (f.type === 'final' || f.type === 'error') {
                clearTimeout(timer)
                resolve(frames)
            }
        })
    })
}

describe('WS /ws（真 ws 客户端 + 假子进程）', () => {
    it('一轮：逐帧透传直到 final', async () => {
        const url = await start()
        const ws = new WebSocket(url)
        await new Promise((r) => ws.once('open', r))
        const round = collectRound(ws)
        ws.send(JSON.stringify({ sessionId: 's1', prompt: 'hello', eventId: 'e1', attempt: 1 }))
        const frames = await round
        expect(frames.map((f) => f.type)).toEqual(['session', 'status', 'delta', 'final'])
        expect(frames.at(-1).text).toBe('echo:hello')
        ws.close()
    })

    it('同连接两轮：第一轮 final 后连接仍可发第二轮', async () => {
        const url = await start()
        const ws = new WebSocket(url)
        await new Promise((r) => ws.once('open', r))
        const r1 = collectRound(ws)
        ws.send(JSON.stringify({ prompt: 'first' }))
        await r1
        const r2 = collectRound(ws)
        ws.send(JSON.stringify({ prompt: 'second' }))
        const frames2 = await r2
        expect(frames2.at(-1).text).toBe('echo:second')
        ws.close()
    })

    it('失败轮：补发 error 帧', async () => {
        const url = await start('fail')
        const ws = new WebSocket(url)
        await new Promise((r) => ws.once('open', r))
        const round = collectRound(ws)
        ws.send(JSON.stringify({ prompt: 'x' }))
        const frames = await round
        // fail 模式子进程自身输出 error 帧；断言流中出现 error
        expect(frames.some((f) => f.type === 'error')).toBe(true)
        ws.close()
    })

    it('非法 payload：回 error 帧且连接可继续下一轮', async () => {
        const url = await start()
        const ws = new WebSocket(url)
        await new Promise((r) => ws.once('open', r))
        const bad = collectRound(ws)
        ws.send(JSON.stringify({ sessionId: 's' }))   // 缺 prompt
        const badFrames = await bad
        expect(badFrames).toEqual([{ type: 'error', message: 'prompt is required' }])
        const good = collectRound(ws)
        ws.send(JSON.stringify({ prompt: 'after-error' }))
        const goodFrames = await good
        expect(goodFrames.at(-1).text).toBe('echo:after-error')
        ws.close()
    })

    it('nofinal 失败轮：子进程没出 error 帧时由 handler 补发', async () => {
        const url = await start('nofinal')
        const ws = new WebSocket(url)
        await new Promise((r) => ws.once('open', r))
        const round = collectRound(ws)
        ws.send(JSON.stringify({ prompt: 'x' }))
        const frames = await round
        expect(frames.at(-1)).toEqual({ type: 'error', message: 'no final frame' })
        ws.close()
    })

    it('非 JSON 消息：处理器抛错，连接被关闭', async () => {
        const url = await start()
        const ws = new WebSocket(url)
        await new Promise((r) => ws.once('open', r))
        const closed = new Promise((r) => ws.once('close', r))
        ws.send('not json at all')
        await closed   // receiveJson 抛 SyntaxError → 非 Disconnect → 上抛 → SDK 关连接
        expect(ws.readyState).toBe(WebSocket.CLOSED)
    })

    it('升级头 sessionId 作缺省回退，payload 优先（BUG-03 回归）', async () => {
        const seen: string[] = []
        const scheduler = new Scheduler({
            launchSpec: (req) => { seen.push(req.sessionId); return fakeSpec() },
        })
        const app = createApp(scheduler)
        server = app.run('127.0.0.1', 0)
        await new Promise((r) => server!.once('listening', r))
        const url = `ws://127.0.0.1:${(server!.address() as AddressInfo).port}/ws`
        const ws = new WebSocket(url, { headers: { 'x-hw-agentarts-session-id': 'hdr-s1' } })
        await new Promise((r) => ws.once('open', r))
        const r1 = collectRound(ws)
        ws.send(JSON.stringify({ prompt: 'first' }))
        await r1
        const r2 = collectRound(ws)
        ws.send(JSON.stringify({ sessionId: 'payload-s', prompt: 'second' }))
        await r2
        expect(seen).toEqual(['hdr-s1', 'payload-s'])
        ws.close()
    })
})
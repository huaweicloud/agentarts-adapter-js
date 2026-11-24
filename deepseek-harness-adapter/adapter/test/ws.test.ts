import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { Scheduler } from '../src/scheduler/index.js'
import type { RoundHandle } from '../src/scheduler/run.js'
import { createApp } from '../src/main.js'
import { fakeSpec, listen as startApp } from './helpers.js'

let server: Server | null = null
async function listen(app: ReturnType<typeof createApp>): Promise<string> {
    const started = await startApp(app)
    server = started.server
    return `ws://${started.base}/ws`
}
async function start(mode = 'normal'): Promise<string> {
    return listen(createApp(new Scheduler({ launchSpec: () => fakeSpec(mode) })))
}
afterEach(async () => {
    // server 为 null 时直接跳过（BUG-09：可选链短路会使 Promise 永不 resolve）
    if (server) await new Promise((r) => server!.close(r))
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

/** 记录 spawn 与 handle 的 scheduler（按 eventId 选 hang/normal） */
function spyScheduler() {
    const spawned: string[] = []
    const handles: Promise<RoundHandle>[] = []
    const scheduler = new Scheduler({
        launchSpec: (req) => {
            spawned.push(req.eventId)
            return fakeSpec(req.eventId === 'e-hang' ? 'hang' : 'normal')
        },
    })
    const origRun = scheduler.run.bind(scheduler)
    scheduler.run = (req, signal) => {
        const p = origRun(req, signal)
        handles.push(p)
        return p
    }
    return { scheduler, spawned, handles }
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

    it('失败轮：恰好一条 error 终态，不重复（BUG-08）', async () => {
        const url = await start('fail')
        const ws = new WebSocket(url)
        await new Promise((r) => ws.once('open', r))
        const round = collectRound(ws)
        ws.send(JSON.stringify({ prompt: 'x' }))
        const frames = await round
        // collectRound 在首个终态即 resolve；listener 仍挂着，等一拍捕获可能的重复帧
        await new Promise((r) => setTimeout(r, 100))
        const errors = frames.filter((f) => f.type === 'error')
        expect(errors).toHaveLength(1)
        expect(errors[0].message).toBe('model exploded')
        ws.close()
    })

    it('final 后子进程失败：客户端只收 error，绝收不到 final（BUG-08）', async () => {
        const url = await start('final-then-fail')
        const ws = new WebSocket(url)
        await new Promise((r) => ws.once('open', r))
        const round = collectRound(ws)
        ws.send(JSON.stringify({ prompt: 'x' }))
        const frames = await round
        await new Promise((r) => setTimeout(r, 100))
        expect(frames.some((f) => f.type === 'final')).toBe(false)
        expect(frames.filter((f) => f.type === 'error')).toHaveLength(1)
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

    it('排队期间断开：被取消的轮次从未 spawn（BUG-06 验收①）', async () => {
        const { scheduler, spawned, handles } = spyScheduler()
        const url = await listen(createApp(scheduler))
        const ws1 = new WebSocket(url)
        await new Promise((r) => ws1.once('open', r))
        ws1.send(JSON.stringify({ sessionId: 's1', prompt: 'x', eventId: 'e-hang', attempt: 1 }))
        // 等第一轮确实 spawn
        const t0 = Date.now()
        while (!spawned.includes('e-hang') && Date.now() - t0 < 5000) {
            await new Promise((r) => setTimeout(r, 20))
        }
        expect(spawned).toEqual(['e-hang'])
        const ws2 = new WebSocket(url)
        await new Promise((r) => ws2.once('open', r))
        ws2.send(JSON.stringify({ sessionId: 's1', prompt: 'y', eventId: 'e-normal', attempt: 1 }))
        await new Promise((r) => setTimeout(r, 100))   // 让 ws2 入队
        ws2.close()                                     // 排队期间断开
        await new Promise((r) => setTimeout(r, 150))
        expect(spawned).toEqual(['e-hang'])             // e-normal 从未 spawn
        ws1.close()                                     // 取消 hang 轮
        const o1 = await (await handles[0]).outcome
        expect(o1.ok).toBe(false)
        expect(o1.error).toContain('cancelled')
    })

    it('执行中断开：首轮 cancelled 结算，同会话第二轮随后启动（BUG-06 回归）', async () => {
        const { scheduler, spawned, handles } = spyScheduler()
        const url = await listen(createApp(scheduler))
        const ws1 = new WebSocket(url)
        await new Promise((r) => ws1.once('open', r))
        const firstFrame = new Promise<void>((resolve) => ws1.once('message', () => resolve()))
        ws1.send(JSON.stringify({ sessionId: 's1', prompt: 'x', eventId: 'e-hang', attempt: 1 }))
        await firstFrame
        ws1.close()
        const o1 = await (await handles[0]).outcome
        expect(o1.ok).toBe(false)
        expect(o1.error).toContain('cancelled')
        // 第二轮（新连接，同会话）随后启动并完成
        const ws2 = new WebSocket(url)
        await new Promise((r) => ws2.once('open', r))
        const r2 = collectRound(ws2)
        ws2.send(JSON.stringify({ sessionId: 's1', prompt: 'y', eventId: 'e-normal', attempt: 1 }))
        const frames2 = await r2
        expect(frames2.at(-1).type).toBe('final')
        expect(spawned).toEqual(['e-hang', 'e-normal'])
        ws2.close()
    })

    it('收到 final 后立即关闭：flush 已完成（BUG-06 验收②）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'dsh-flush-'))
        const scheduler = new Scheduler({
            launchSpec: (req) => fakeSpec('normal', {
                AGENTRUN_TEST_FLUSH_DIR: dir,
                AGENTRUN_DSH_SESSION_ID: req.sessionId,
                AGENTRUN_EVENT_ID: req.eventId,
            }),
        })
        const url = await listen(createApp(scheduler))
        const ws = new WebSocket(url)
        await new Promise((r) => ws.once('open', r))
        const round = collectRound(ws)
        ws.send(JSON.stringify({ sessionId: 's1', prompt: 'x', eventId: 'e1', attempt: 1 }))
        const frames = await round
        expect(frames.at(-1).type).toBe('final')
        ws.close()   // 收到成功终态立即关闭
        expect(existsSync(join(dir, 'flush-s1-e1.json'))).toBe(true)
    })
})
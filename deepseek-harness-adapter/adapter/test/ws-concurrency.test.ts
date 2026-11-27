import type { Server } from 'node:http'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { Scheduler } from '../src/scheduler/index.js'
import type { RoundHandle } from '../src/scheduler/run.js'
import { createApp } from '../src/main.js'
import { fakeSpec, listen } from './helpers.js'

/** 满载拒绝帧（适配层定义的业务错误帧；SDK 不向不透明协议自动注入 JSON） */
const BUSY_FRAME = {
    type: 'error',
    code: 'CONCURRENCY_LIMIT_EXCEEDED',
    message: 'Service busy - maximum concurrency reached',
}

let server: Server | null = null
const clients: WebSocket[] = []
const allHandles: Promise<RoundHandle>[] = []

async function start(scheduler: Scheduler): Promise<{ wsUrl: string; httpBase: string }> {
    const started = await listen(createApp(scheduler, 1))
    server = started.server
    return { wsUrl: `ws://${started.base}/ws`, httpBase: `http://${started.base}` }
}

afterEach(async () => {
    // 兜底清理：断言失败时也要关连接、取消所有轮次，避免孤儿子进程挂住 server.close
    for (const ws of clients) ws.terminate()
    clients.length = 0
    for (const p of allHandles) {
        const h = await p.catch(() => null)
        h?.cancel()
        if (h) await h.outcome
    }
    allHandles.length = 0
    if (server) await new Promise((r) => server!.close(r))
    server = null
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

/** 记录 spawn 与 handle 的 scheduler（eventId 前缀选 hang/fail/normal） */
function spyScheduler() {
    const spawned: string[] = []
    const handles: Promise<RoundHandle>[] = []
    const scheduler = new Scheduler({
        launchSpec: (req) => {
            spawned.push(req.eventId)
            const mode = req.eventId.startsWith('e-hang') ? 'hang'
                : req.eventId.startsWith('e-fail') ? 'fail' : 'normal'
            return fakeSpec(mode)
        },
    })
    const origRun = scheduler.run.bind(scheduler)
    scheduler.run = (req, signal) => {
        const p = origRun(req, signal)
        handles.push(p)
        allHandles.push(p)
        return p
    }
    return { scheduler, spawned, handles }
}

async function openWs(url: string): Promise<WebSocket> {
    const ws = new WebSocket(url)
    clients.push(ws)
    await new Promise((r) => ws.once('open', r))
    return ws
}

async function waitSpawn(spawned: string[], eventId: string): Promise<void> {
    const t0 = Date.now()
    while (!spawned.includes(eventId) && Date.now() - t0 < 5000) await sleep(20)
    expect(spawned).toContain(eventId)
}

function postRound(base: string, body: Record<string, unknown>, signal?: AbortSignal) {
    return fetch(`${base}/invocations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    })
}

describe('WS 并发名额（issue #10 验收，maxConcurrency=1）', () => {
    it('满载时不同 sessionId 第二轮：busy 错误帧、不 spawn、连接存活', async () => {
        const { scheduler, spawned, handles } = spyScheduler()
        const { wsUrl } = await start(scheduler)
        const ws1 = await openWs(wsUrl)
        ws1.send(JSON.stringify({ sessionId: 's1', prompt: 'x', eventId: 'e-hang', attempt: 1 }))
        await waitSpawn(spawned, 'e-hang')
        const ws2 = await openWs(wsUrl)
        const busy = collectRound(ws2)
        ws2.send(JSON.stringify({ sessionId: 's2', prompt: 'y', eventId: 'e-normal', attempt: 1 }))
        expect(await busy).toEqual([BUSY_FRAME])
        expect(spawned).toEqual(['e-hang'])
        // 首轮取消、子进程退出后名额释放：ws2 连接仍可用，能再发新轮
        ws1.close()
        await (await handles[0]).outcome
        await sleep(100)
        const next = collectRound(ws2)
        ws2.send(JSON.stringify({ sessionId: 's2', prompt: 'z', eventId: 'e-after', attempt: 1 }))
        const frames = await next
        expect(frames.at(-1).type).toBe('final')
        expect(frames.at(-1).text).toBe('echo:z')
        expect(spawned).toEqual(['e-hang', 'e-after'])
        ws2.close()
    })

    it('成功轮结束后名额释放：后续 hang 轮可占用，第三轮被拒', async () => {
        const { scheduler, spawned, handles } = spyScheduler()
        const { wsUrl } = await start(scheduler)
        const ws = await openWs(wsUrl)
        const r1 = collectRound(ws)
        ws.send(JSON.stringify({ sessionId: 's1', prompt: 'first', eventId: 'e1', attempt: 1 }))
        expect((await r1).at(-1).type).toBe('final')
        await (await handles[0]).outcome   // 等子进程退出与名额释放
        await sleep(50)
        ws.send(JSON.stringify({ sessionId: 's1', prompt: 'x', eventId: 'e-hang', attempt: 1 }))
        await waitSpawn(spawned, 'e-hang')
        // 探针必须走另一条连接：本连接 handler 正忙于 hang 轮，不会读下一条消息
        const ws2 = await openWs(wsUrl)
        const busy = collectRound(ws2)
        ws2.send(JSON.stringify({ sessionId: 's2', prompt: 'probe', eventId: 'e-probe', attempt: 1 }))
        expect(await busy).toEqual([BUSY_FRAME])
        expect(spawned).toEqual(['e1', 'e-hang'])
        ws.close()
        ws2.close()
        await (await handles[1]).outcome
    })

    it('失败轮结束后名额释放：后续 hang 轮可占用', async () => {
        const { scheduler, spawned, handles } = spyScheduler()
        const { wsUrl } = await start(scheduler)
        const ws = await openWs(wsUrl)
        const r1 = collectRound(ws)
        ws.send(JSON.stringify({ sessionId: 's1', prompt: 'x', eventId: 'e-fail', attempt: 1 }))
        expect((await r1).at(-1).type).toBe('error')
        await (await handles[0]).outcome
        await sleep(50)
        ws.send(JSON.stringify({ sessionId: 's1', prompt: 'y', eventId: 'e-hang', attempt: 1 }))
        await waitSpawn(spawned, 'e-hang')
        const ws2 = await openWs(wsUrl)
        const busy = collectRound(ws2)
        ws2.send(JSON.stringify({ sessionId: 's2', prompt: 'probe', eventId: 'e-probe', attempt: 1 }))
        expect(await busy).toEqual([BUSY_FRAME])
        ws.close()
        ws2.close()
        await (await handles[1]).outcome
    })

    it('空闲 WS 连接不占名额：invocations 仍可执行', async () => {
        const { scheduler } = spyScheduler()
        const { wsUrl, httpBase } = await start(scheduler)
        await openWs(wsUrl)   // 只建连，不发轮次
        const res = await postRound(httpBase, {
            sessionId: 's1', prompt: 'hello', eventId: 'e1', attempt: 1,
        })
        expect(res.status).toBe(200)
        expect((await res.json()).result).toBe('echo:hello')
    })

    it('WS 占满名额：invocations 返回 503', async () => {
        const { scheduler, spawned, handles } = spyScheduler()
        const { wsUrl, httpBase } = await start(scheduler)
        const ws = await openWs(wsUrl)
        ws.send(JSON.stringify({ sessionId: 's1', prompt: 'x', eventId: 'e-hang', attempt: 1 }))
        await waitSpawn(spawned, 'e-hang')
        const res = await postRound(httpBase, { prompt: 'y' })
        expect(res.status).toBe(503)
        expect((await res.json()).error).toBe('Service busy - maximum concurrency reached')
        ws.close()
        await (await handles[0]).outcome
    })

    it('WS 占满名额：/ping 返回 HealthyBusy', async () => {
        const { scheduler, spawned, handles } = spyScheduler()
        const { wsUrl, httpBase } = await start(scheduler)
        const ws = await openWs(wsUrl)
        ws.send(JSON.stringify({ sessionId: 's1', prompt: 'x', eventId: 'e-hang', attempt: 1 }))
        await waitSpawn(spawned, 'e-hang')
        const res = await fetch(`${httpBase}/ping`)
        expect(await res.text()).toContain('HealthyBusy')
        ws.close()
        await (await handles[0]).outcome
    })

    it('HTTP 占满名额：WS 轮次被拒', async () => {
        const { scheduler, spawned, handles } = spyScheduler()
        const { wsUrl, httpBase } = await start(scheduler)
        const ac = new AbortController()
        postRound(httpBase, {
            sessionId: 's1', prompt: 'x', eventId: 'e-hang', attempt: 1,
        }, ac.signal).catch(() => {})
        await waitSpawn(spawned, 'e-hang')
        const ws = await openWs(wsUrl)
        const busy = collectRound(ws)
        ws.send(JSON.stringify({ sessionId: 's2', prompt: 'y', eventId: 'e-normal', attempt: 1 }))
        expect(await busy).toEqual([BUSY_FRAME])
        expect(spawned).toEqual(['e-hang'])
        ws.close()
        ac.abort()
        const h = await handles[0]
        h.cancel()   // 兜底取消：signal 未接入时也不留孤儿子进程
        await h.outcome
    })

    it('HTTP 断连：执行中的轮次被取消结算，名额随之释放', async () => {
        const { scheduler, spawned, handles } = spyScheduler()
        const { wsUrl, httpBase } = await start(scheduler)
        const ac = new AbortController()
        postRound(httpBase, {
            sessionId: 's1', prompt: 'x', eventId: 'e-hang', attempt: 1,
        }, ac.signal).catch(() => {})
        await waitSpawn(spawned, 'e-hang')
        ac.abort()
        const h = await handles[0]
        // 断连应经 context.signal 取消轮次；限时等待，超时则兜底取消并判失败
        const settled = await Promise.race([h.outcome.then(() => true), sleep(3000).then(() => false)])
        if (!settled) {
            h.cancel()
            await h.outcome
        }
        expect(settled, 'HTTP 断连应取消执行中的轮次').toBe(true)
        expect((await h.outcome).error).toContain('cancelled')
        // 名额随取消释放：WS 轮随后可执行
        await sleep(100)
        const ws = await openWs(wsUrl)
        const round = collectRound(ws)
        ws.send(JSON.stringify({ sessionId: 's2', prompt: 'y', eventId: 'e-after', attempt: 1 }))
        expect((await round).at(-1).type).toBe('final')
        ws.close()
    })
})
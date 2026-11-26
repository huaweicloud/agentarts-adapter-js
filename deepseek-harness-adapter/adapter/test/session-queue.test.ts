import { describe, expect, it } from 'vitest'
import { SessionQueue } from '../src/scheduler/session-queue.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('SessionQueue', () => {
    it('同 sessionId 串行：后入队的 job 等前序完成', async () => {
        const queue = new SessionQueue()
        const order: string[] = []
        const p1 = queue.enqueue('s1', async () => {
            order.push('a-start'); await sleep(30); order.push('a-end'); return 1
        })
        const p2 = queue.enqueue('s1', async () => {
            order.push('b-start'); return 2
        })
        expect(await Promise.all([p1, p2])).toEqual([1, 2])
        expect(order).toEqual(['a-start', 'a-end', 'b-start'])
    })

    it('不同 sessionId 并行', async () => {
        const queue = new SessionQueue()
        let running = 0
        let maxRunning = 0
        const job = async () => {
            running += 1; maxRunning = Math.max(maxRunning, running)
            await sleep(20); running -= 1
        }
        await Promise.all([queue.enqueue('s1', job), queue.enqueue('s2', job)])
        expect(maxRunning).toBe(2)
    })

    it('前序 job 失败不阻塞后续，且错误如实抛给调用方', async () => {
        const queue = new SessionQueue()
        const p1 = queue.enqueue('s1', async () => { throw new Error('boom') })
        const p2 = queue.enqueue('s1', async () => 'ok')
        await expect(p1).rejects.toThrow('boom')
        expect(await p2).toBe('ok')
    })

    it('空闲后清理条目（不泄漏 Map）', async () => {
        const queue = new SessionQueue()
        await queue.enqueue('s1', async () => 1)
        await sleep(10)
        expect(queue.size()).toBe(0)
    })
})
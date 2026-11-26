import { describe, expect, it } from 'vitest'
import { AsyncQueue } from '../src/async-queue.js'

const largeEvent = { type: 'tool', payload: 'x'.repeat(4 * 1024 * 1024) }

describe('ACP event buffer', () => {
    it('delivers a large event directly when a reader is waiting', async () => {
        const queue = new AsyncQueue()
        const reader = queue[Symbol.asyncIterator]()
        const next = reader.next()
        expect(queue.push(largeEvent)).toBe(true)
        expect((await next).value).toBe(largeEvent)
        queue.end()
        expect((await reader.next()).done).toBe(true)
    })

    it('buffers a notice for an oversized event and preserves later events', async () => {
        const notice = { type: 'dropped' }
        const queue = new AsyncQueue<{ type: string; payload?: string }>(true, () => notice)
        const smallerEvent = { type: 'delta' }
        expect(queue.push(largeEvent)).toBe(true)
        expect(queue.push(smallerEvent)).toBe(true)
        queue.end()
        expect(await Array.fromAsync(queue)).toEqual([notice, smallerEvent])
    })

    it('rejects waiting readers and later iterations with the failure', async () => {
        const queue = new AsyncQueue<number>()
        const iterator = queue[Symbol.asyncIterator]()
        const pending = iterator.next()
        queue.fail(new Error('acp child closed'))
        await expect(pending).rejects.toThrow('acp child closed')
        await expect(Array.fromAsync(queue)).rejects.toThrow('acp child closed')
    })

    it('ignores events after end and keeps result-only queues empty', async () => {
        const queue = new AsyncQueue<number>()
        queue.end()
        expect(queue.push(1)).toBe(true)
        expect(await Array.fromAsync(queue)).toEqual([])

        const resultOnly = new AsyncQueue<number>(false)
        expect(resultOnly.push(2)).toBe(true)
        expect(resultOnly.push(3)).toBe(true)
        resultOnly.end()
        expect(await Array.fromAsync(resultOnly)).toEqual([])
    })
})

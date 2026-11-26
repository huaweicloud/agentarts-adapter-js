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
})

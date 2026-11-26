/**
 * Push-to-pull bridge used by one prompt run: ACP notifications push events,
 * the SSE iterator (or frame adapter) pulls them in order.
 */
export class AsyncQueue<T> {
    private values: Array<{ value: T; bytes: number }> = []
    private bytes = 0

    constructor(
        private readonly enabled = true,
        private readonly oversizedNotice?: (event: T) => T,
    ) {}

    private waiters: Array<{
        resolve: (result: IteratorResult<T>) => void
        reject: (error: unknown) => void
    }> = []
    private ended = false
    private failure: unknown = null

    push(value: T): boolean {
        if (this.ended || !this.enabled) return true
        const waiter = this.waiters.shift()
        if (waiter) {
            waiter.resolve({ done: false, value })
            return true
        }

        const maxBytes = 4 * 1024 * 1024
        let bytes = Buffer.byteLength(JSON.stringify(value))
        const oversized = bytes > maxBytes
        if (oversized) {
            const notice = this.oversizedNotice?.(value)
            if (notice === undefined) return true
            value = notice
            bytes = Buffer.byteLength(JSON.stringify(notice))
        }
        if (this.values.length >= 1024 || this.bytes + bytes > maxBytes) {
            if (oversized) return true
            this.values.length = 0
            this.bytes = 0
            return false
        }
        this.values.push({ value, bytes })
        this.bytes += bytes
        return true
    }

    end(): void {
        if (this.ended) return
        this.ended = true
        for (const waiter of this.waiters.splice(0)) {
            waiter.resolve({ done: true, value: undefined })
        }
    }

    fail(error: unknown): void {
        if (this.ended) return
        this.ended = true
        this.failure = error
        for (const waiter of this.waiters.splice(0)) {
            waiter.reject(error)
        }
    }

    async *[Symbol.asyncIterator](): AsyncIterator<T> {
        while (true) {
            if (this.values.length > 0) {
                const item = this.values.shift()!
                this.bytes -= item.bytes
                yield item.value
                continue
            }
            if (this.failure !== null) throw this.failure
            if (this.ended) return
            const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
                this.waiters.push({ resolve, reject })
            })
            if (next.done) return
            yield next.value
        }
    }
}

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

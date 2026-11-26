/**
 * Push-to-pull bridge used by one prompt run: ACP notifications push events,
 * the SSE iterator (or frame adapter) pulls them in order.
 */
export class AsyncQueue<T> {
    private values: T[] = []
    private waiters: Array<{
        resolve: (result: IteratorResult<T>) => void
        reject: (error: unknown) => void
    }> = []
    private ended = false
    private failure: unknown = null

    push(value: T): void {
        if (this.ended) return
        const waiter = this.waiters.shift()
        if (waiter !== undefined) {
            waiter.resolve({ done: false, value })
        } else {
            this.values.push(value)
        }
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
                yield this.values.shift() as T
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

/**
 * 同 sessionId 串行队列（spec §4.4）：一个会话同一时刻只由一个子进程持有。
 * 全局并发上限不在这里——由 SDK maxConcurrency 执行。
 */
export class SessionQueue {
    /** 每个会话的队尾 Promise；新 job 接在队尾之后 */
    private tails = new Map<string, Promise<unknown>>()

    /** 当前排队/执行中的会话数（测试与观测用） */
    size(): number {
        return this.tails.size
    }

    enqueue<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
        const prev = this.tails.get(sessionId) ?? Promise.resolve()
        // 前序成功或失败都接着跑（失败不阻塞会话后续请求）
        const run = prev.then(job, job)
        // 队尾只关心"完成"，不携带结果与错误，避免未处理 rejection
        const tail = run.then(() => undefined, () => undefined)
        this.tails.set(sessionId, tail)
        // 队尾结算时若没有更新的 job 接上，则清理条目
        void tail.then(() => {
            if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId)
        })
        return run
    }
}
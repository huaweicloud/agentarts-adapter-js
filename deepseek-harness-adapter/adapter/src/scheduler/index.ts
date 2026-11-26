import type { RoundHandle } from './run.js'
import { cancelledHandle, runRound } from './run.js'
import { SessionQueue } from './session-queue.js'
import type { SchedulerDeps } from '../types.js'
import type { RoundRequest } from '@agentarts/harness-dsh-shared'

/**
 * 调度器门面：同 sessionId 串行（SessionQueue）+ 每轮一个子进程（runRound）。
 * 全局并发上限由 SDK maxConcurrency 执行，不在本层。
 */
export class Scheduler {
    private queue = new SessionQueue()

    constructor(private deps: SchedulerDeps) {}

    run(req: RoundRequest, signal?: AbortSignal): Promise<RoundHandle> {
        return new Promise<RoundHandle>((resolve, reject) => {
            void this.queue.enqueue(req.sessionId, async () => {
                // 排队期间被取消：跳过 recall/launchSpec/spawn
                if (signal?.aborted) {
                    resolve(cancelledHandle('round cancelled before spawn'))
                    return
                }
                // 召回失败降级为空，不阻塞执行
                let recallResult = ''
                try {
                    recallResult = (await this.deps.recall?.(req)) ?? ''
                } catch {
                    recallResult = ''
                }
                const spec = await this.deps.launchSpec(req, recallResult)
                // spawn 前由 runRound 再检查一次 signal（覆盖 recall/launchSpec 期间取消）
                const handle = runRound(spec, req.prompt, this.deps.timeoutMs, signal)
                // 先把 handle 交给调用方（处理器要边跑边消费帧流）……
                resolve(handle)
                // ……但队列名额必须等本轮结束才释放，否则同会话会并行两个子进程
                await handle.outcome
            }).catch(reject)
        })
    }
}
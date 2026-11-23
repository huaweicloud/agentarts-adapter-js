import type { RoundHandle } from './run.js'
import { runRound } from './run.js'
import { SessionQueue } from './session-queue.js'
import type { SchedulerDeps } from '../types.js'
import type { RoundRequest } from '@agentarts/harness-dsh-shared'

/**
 * B 模块门面：同 sessionId 串行（SessionQueue）+ 每轮一个子进程（runRound）。
 * 全局并发上限由 SDK maxConcurrency 执行，不在本层。
 */
export class Scheduler {
    private queue = new SessionQueue()

    constructor(private deps: SchedulerDeps) {}

    run(req: RoundRequest): Promise<RoundHandle> {
        return new Promise<RoundHandle>((resolve, reject) => {
            void this.queue.enqueue(req.sessionId, async () => {
                // 召回失败降级为空（spec §2.2 第 3 步），不阻塞执行
                let recallResult = ''
                try {
                    recallResult = (await this.deps.recall?.(req)) ?? ''
                } catch {
                    recallResult = ''
                }
                const spec = await this.deps.launchSpec(req, recallResult)
                const handle = runRound(spec, req.prompt, this.deps.timeoutMs)
                // 先把 handle 交给调用方（A 要边跑边消费帧流）……
                resolve(handle)
                // ……但队列名额必须等本轮结束才释放，否则同会话会并行两个子进程
                await handle.outcome
            }).catch(reject)
        })
    }
}
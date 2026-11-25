import type { Frame, FinalFrame } from './frames.js'
import type { RoundRequest } from './launch.js'

/** 一轮的执行结果：执行层在子进程真正结束后结算。 */
export interface RoundOutcome {
    ok: boolean
    final: FinalFrame | null
    error: string | null
    exitCode: number | null
}

/** 上层协议处理器消费的一轮句柄：帧流 + 结算 + 幂等取消。 */
export interface RoundHandle {
    /** 帧流，单消费者；执行层结束且缓冲 drain 后迭代完成 */
    frames: AsyncIterable<Frame>
    /** 子进程/轮次实际结束后结算（队列名额随之释放） */
    outcome: Promise<RoundOutcome>
    /** 幂等取消：与外部 AbortSignal 收敛到同一终止路径 */
    cancel(): void
}

/**
 * 执行后端的结构契约：spawn-per-round 与 ACP runtime 都实现它，
 * 上层处理器（/invocations、WS、A2A、AG-UI）因此不感知具体后端。
 */
export interface SchedulerLike {
    run(req: RoundRequest, signal?: AbortSignal): Promise<RoundHandle>
}

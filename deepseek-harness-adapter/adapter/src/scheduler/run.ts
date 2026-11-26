import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
    parseFrame, type Frame, type FinalFrame, type ErrorFrame, type LaunchSpec,
} from '@agentarts/harness-dsh-shared'
import { createFrameChannel } from './frame-channel.js'

/** 一轮超时默认值（先按 5 分钟，待与平台对齐后调整） */
export const DEFAULT_ROUND_TIMEOUT_MS = 300_000
/** 取消宽限期：先 SIGTERM 让 DSH 清理（该路径可能以 0 退出），宽限后未退出再 SIGKILL */
export const CANCEL_GRACE_MS = 5_000

export interface RoundOutcome {
    ok: boolean
    final: FinalFrame | null
    error: string | null
    exitCode: number | null
}

export interface RoundHandle {
    /** 帧流，单消费者；子进程结束且缓冲 drain 后迭代完成 */
    frames: AsyncIterable<Frame>
    /** 子进程实际 close 后结算（队列名额随之释放） */
    outcome: Promise<RoundOutcome>
    /** 幂等取消：与外部 AbortSignal 收敛到同一 terminate 路径 */
    cancel(): void
}

/** 从未 spawn 的轮次（排队期间/ spawn 前被取消）：空帧流 + 已结算 outcome */
export function cancelledHandle(error: string): RoundHandle {
    return {
        frames: (async function* () {})(),
        outcome: Promise.resolve({ ok: false, final: null, error, exitCode: null }),
        cancel: () => {},
    }
}

/**
 * 执行一轮：spawn 子进程，stdin 写任务，stdout 逐行解析帧，
 * 按退出码与 final 帧判成败。执行层不缓存结果——幂等判重在子进程（driver）内。
 * 取消：signal 或 handle.cancel() 触发优雅终止，首个终止原因只记录一次。
 */
export function runRound(
    spec: LaunchSpec, task: string, timeoutMs = DEFAULT_ROUND_TIMEOUT_MS, signal?: AbortSignal,
): RoundHandle {
    // spawn 前已取消：不启动子进程
    if (signal?.aborted) return cancelledHandle('round cancelled before spawn')

    let final: FinalFrame | null = null
    let errorFrame: ErrorFrame | null = null
    let stderrTail = ''
    let failReason: string | null = null
    let settled = false

    const child = spawn(spec.command, spec.args, {
        env: spec.env, stdio: ['pipe', 'pipe', 'pipe'],
    })
    // 字节水位背压：慢消费者使队列超高水位 → 暂停子进程 stdout，
    // 管道写满后 driver 自然阻塞；消费回落到低水位 → 恢复
    const channel = createFrameChannel({
        onPause: () => child.stdout.pause(),
        onResume: () => child.stdout.resume(),
    })
    let graceTimer: NodeJS.Timeout | null = null

    // 取消入口：先记原因再 SIGTERM，宽限后 SIGKILL；已退出/已结算则 no-op（幂等）
    const terminate = (reason: string) => {
        failReason ??= reason
        if (settled || child.exitCode !== null) return
        child.kill('SIGTERM')
        graceTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL')
        }, CANCEL_GRACE_MS)
    }
    const onCancel = () => terminate('round cancelled by consumer')
    signal?.addEventListener('abort', onCancel, { once: true })

    const outcome = new Promise<RoundOutcome>((resolve) => {
        const timer = setTimeout(() => {
            failReason ??= `round timeout after ${timeoutMs}ms`
            child.kill('SIGKILL')
        }, timeoutMs)

        child.on('error', (err) => {
            clearTimeout(timer)
            failReason ??= `spawn failed: ${err.message}`
            channel.end()
            settled = true
            resolve({ ok: false, final: null, error: failReason, exitCode: null })
        })

        const lines = createInterface({ input: child.stdout })
        lines.on('line', (line) => {
            const r = parseFrame(line)
            if (r.ok) {
                // 终态帧暂存校验，不进帧流；退出后由 outcome 统一给出唯一终态
                if (r.frame.type === 'final') { final ??= r.frame; return }
                if (r.frame.type === 'error') { errorFrame ??= r.frame; return }
                channel.push(r.frame, Buffer.byteLength(line))
            } else if (r.reason === 'invalid') {
                // 协议被破坏：立即判失败并终止子进程
                failReason ??= `invalid frame line: ${line.slice(0, 200)}`
                child.kill('SIGKILL')
            }
        })

        child.stderr.on('data', (chunk) => {
            stderrTail = (stderrTail + String(chunk)).slice(-8192)
        })

        child.on('close', (code) => {
            clearTimeout(timer)
            if (graceTimer) clearTimeout(graceTimer)
            signal?.removeEventListener('abort', onCancel)
            channel.end()
            settled = true
            // 终态综合判定：exit 0 + 合法 final + 无失败原因 + 无 driver error 帧。
            // final 后 exit 1（flush 失败）→ 失败，客户端绝不会收到 final。
            // SIGTERM 清理路径可能以 0 退出，但 failReason 已置 → 仍判失败。
            const ok = code === 0 && final !== null && failReason === null && errorFrame === null
            const error = ok ? null
                : failReason
                    ?? errorFrame?.message
                    ?? (code !== 0 ? `exit ${code}: ${stderrTail}` : 'no final frame')
            resolve({ ok, final, error, exitCode: code })
        })

        // 子进程早退时 stdin 可能 EPIPE，忽略（成败由 close/error 判定）
        child.stdin.on('error', () => {})
        child.stdin.end(spec.encodeStdin(task))
    })

    return { frames: channel.frames, outcome, cancel: onCancel }
}
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
    parseFrame, type Frame, type FinalFrame, type LaunchSpec,
} from '@agentarts/harness-dsh-shared'

/** 一轮超时默认值（spec §7 第 8 项待与平台对齐，先按 5 分钟） */
export const DEFAULT_ROUND_TIMEOUT_MS = 300_000

export interface RoundOutcome {
    ok: boolean
    final: FinalFrame | null
    error: string | null
    exitCode: number | null
}

export interface RoundHandle {
    /** 帧流，单消费者；子进程结束且缓冲 drain 后迭代完成 */
    frames: AsyncIterable<Frame>
    /** 子进程退出后结算 */
    outcome: Promise<RoundOutcome>
}

/** 简易帧通道：生产端 push/end，消费端异步迭代（单消费者，无背压需求——帧量小） */
function createFrameChannel() {
    const queue: Frame[] = []
    let notify: (() => void) | null = null
    let ended = false
    return {
        push(frame: Frame) { queue.push(frame); notify?.() },
        end() { ended = true; notify?.() },
        frames: {
            async *[Symbol.asyncIterator]() {
                while (true) {
                    while (queue.length > 0) yield queue.shift()!
                    if (ended) return
                    // 检查与注册在同一同步段内完成，不会丢失唤醒
                    await new Promise<void>((resolve) => { notify = resolve })
                    notify = null
                }
            },
        } as AsyncIterable<Frame>,
    }
}

/**
 * 执行一轮（spec §3.2）：spawn 子进程，stdin 写任务，stdout 逐行解析帧，
 * 按退出码与 final 帧判成败。B 不缓存结果——幂等判重在子进程内（D）。
 */
export function runRound(
    spec: LaunchSpec, task: string, timeoutMs = DEFAULT_ROUND_TIMEOUT_MS,
): RoundHandle {
    const channel = createFrameChannel()
    let final: FinalFrame | null = null
    let stderrTail = ''
    let failReason: string | null = null

    const child = spawn(spec.command, spec.args, {
        env: spec.env, stdio: ['pipe', 'pipe', 'pipe'],
    })

    const outcome = new Promise<RoundOutcome>((resolve) => {
        const timer = setTimeout(() => {
            failReason = `round timeout after ${timeoutMs}ms`
            child.kill('SIGKILL')
        }, timeoutMs)

        child.on('error', (err) => {
            clearTimeout(timer)
            failReason = `spawn failed: ${err.message}`
            channel.end()
            resolve({ ok: false, final: null, error: failReason, exitCode: null })
        })

        const lines = createInterface({ input: child.stdout })
        lines.on('line', (line) => {
            const r = parseFrame(line)
            if (r.ok) {
                if (r.frame.type === 'final') final = r.frame
                channel.push(r.frame)
            } else if (r.reason === 'invalid') {
                // 协议被破坏：立即判失败并终止子进程
                failReason = `invalid frame line: ${line.slice(0, 200)}`
                child.kill('SIGKILL')
            }
        })

        child.stderr.on('data', (chunk) => {
            stderrTail = (stderrTail + String(chunk)).slice(-8192)
        })

        child.on('close', (code) => {
            clearTimeout(timer)
            channel.end()
            const ok = code === 0 && final !== null && failReason === null
            const error = ok ? null
                : failReason
                    ?? (code !== 0 ? `exit ${code}: ${stderrTail}` : 'no final frame')
            resolve({ ok, final, error, exitCode: code })
        })

        // 子进程早退时 stdin 可能 EPIPE，忽略（成败由 close/error 判定）
        child.stdin.on('error', () => {})
        child.stdin.end(spec.encodeStdin(task))
    })

    return { frames: channel.frames, outcome }
}
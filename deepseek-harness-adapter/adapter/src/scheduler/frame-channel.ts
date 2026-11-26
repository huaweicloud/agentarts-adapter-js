import type { Frame } from '@agentarts/harness-dsh-shared'

export interface ChannelHooks {
    onPause?(): void
    onResume?(): void
}

interface Queued { frame: Frame; bytes: number }

export const HIGH_WATER_BYTES = 4 * 1024 * 1024
export const LOW_WATER_BYTES = 1 * 1024 * 1024

/**
 * 帧通道：生产端 push/end，消费端异步迭代（单消费者）。
 * 字节水位背压：队列超高水位触发 onPause（runRound 接子进程 stdout.pause），
 * 消费回落到低水位触发 onResume——慢消费者下内存上界 = 水位 + 管道缓冲，与轮次长度无关。
 */
export function createFrameChannel(
    hooks: ChannelHooks = {}, highBytes = HIGH_WATER_BYTES, lowBytes = LOW_WATER_BYTES,
) {
    const queue: Queued[] = []
    let queuedBytes = 0
    let paused = false
    let notify: (() => void) | null = null
    let ended = false
    return {
        push(frame: Frame, bytes: number) {
            queue.push({ frame, bytes })
            queuedBytes += bytes
            if (!paused && queuedBytes >= highBytes) {
                paused = true
                hooks.onPause?.()
            }
            notify?.()
        },
        end() { ended = true; notify?.() },
        frames: {
            async *[Symbol.asyncIterator]() {
                while (true) {
                    while (queue.length > 0) {
                        const item = queue.shift()!
                        queuedBytes -= item.bytes
                        if (paused && queuedBytes <= lowBytes) {
                            paused = false
                            hooks.onResume?.()
                        }
                        yield item.frame
                    }
                    if (ended) return
                    // 检查与注册在同一同步段内完成，不会丢失唤醒
                    await new Promise<void>((resolve) => { notify = resolve })
                    notify = null
                }
            },
        } as AsyncIterable<Frame>,
    }
}
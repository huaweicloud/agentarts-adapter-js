/** 一轮任务的请求四元组（平台 /invocations 入参，spec §2.2）。 */
export interface RoundRequest {
    sessionId: string
    prompt: string
    eventId: string
    attempt: number
}

/**
 * spawn 参数规格（spec §3.5）：B.run 不硬编码 harness 命令，
 * 由 C 的 harness 半边注入；换 harness 只换此对象与 driver。
 */
export interface LaunchSpec {
    command: string
    args: string[]
    env: Record<string, string>
    encodeStdin(task: string): string
}
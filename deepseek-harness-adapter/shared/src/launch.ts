/** 一轮任务的请求四元组（平台 /invocations 入参）。 */
export interface RoundRequest {
    sessionId: string
    prompt: string
    eventId: string
    attempt: number
}

/**
 * spawn 参数规格：执行层不硬编码 harness 命令，
 * 由装配侧注入；换 harness 只换此对象与 driver。
 */
export interface LaunchSpec {
    command: string
    args: string[]
    env: Record<string, string>
    encodeStdin(task: string): string
}
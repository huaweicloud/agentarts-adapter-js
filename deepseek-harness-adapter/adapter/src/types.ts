import type { LaunchSpec, RoundRequest } from '@agentarts/harness-dsh-shared'

/** 与 SDK model.ts 的 SESSION_HEADER 同值；SDK runtime 子路径未导出该常量，故本地定义 */
export const SESSION_HEADER = 'x-hw-agentarts-session-id'

/** Scheduler 的注入端口：launchSpec 与 recall 由装配侧注入，可替换为真实实现 */
export interface SchedulerDeps {
    launchSpec(req: RoundRequest, recallResult: string): LaunchSpec | Promise<LaunchSpec>
    /** 记忆/知识库召回。调度器负责超时降级，provider 可用 signal 中止底层请求。 */
    recall?(req: RoundRequest, signal: AbortSignal): Promise<string>
    timeoutMs?: number
}
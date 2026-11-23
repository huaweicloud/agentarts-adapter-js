import type { LaunchSpec, RoundRequest } from '@agentarts/harness-dsh-shared'

/** 与 SDK model.ts 的 SESSION_HEADER 同值；SDK runtime 子路径未导出该常量，故本地定义 */
export const SESSION_HEADER = 'x-hw-agentarts-session-id'

/** Scheduler 的注入端口：launchSpec 与 recall 由 C 模块提供（P3 接入真实实现） */
export interface SchedulerDeps {
    launchSpec(req: RoundRequest, recallResult: string): LaunchSpec | Promise<LaunchSpec>
    /** 记忆/知识库召回；300ms 超时降级编排在 C 的 recall.ts，此处只消费 */
    recall?(req: RoundRequest): Promise<string>
    timeoutMs?: number
}
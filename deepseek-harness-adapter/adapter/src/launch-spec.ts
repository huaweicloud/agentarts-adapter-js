import {
    ENV_SESSION_ID, ENV_EVENT_ID, ENV_ATTEMPT, ENV_RECALL_RESULT, readInstrumentationChildEnv,
    type LaunchSpec, type RoundRequest,
} from '@agentarts/harness-dsh-shared'

/** 精确白名单；DataLake 端点凭证变量名待确认后补充 */
const PASSTHROUGH = [
    'DSH_HOME', 'PATH', 'HOME', 'NODE_ENV', 'TZ', 'LANG',
    'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
]

/**
 * 最小可运行版 LaunchSpec，白名单与凭证逻辑后续扩充，
 * 此处保证适配器独立可运行。不全量继承 Adapter 环境——召回凭证不进子进程。
 * 前缀放行仅 AGENTRUN_*；MCP 只放行端点变量 MCP_*_URL，凭证类变量一律过滤。
 */
export function buildLaunchSpec(req: RoundRequest, recallResult: string): LaunchSpec {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue
        if (PASSTHROUGH.includes(key)
            || key.startsWith('AGENTRUN_')
            || (key.startsWith('MCP_') && key.endsWith('_URL'))) {
            env[key] = value
        }
    }
    // Observation config goes to the child with the plugin's canonical lower-case names.
    Object.assign(env, readInstrumentationChildEnv(process.env))
    env[ENV_SESSION_ID] = req.sessionId
    env[ENV_EVENT_ID] = req.eventId
    env[ENV_ATTEMPT] = String(req.attempt)
    env[ENV_RECALL_RESULT] = recallResult
    return { command: 'dsh', args: ['--profile', 'agentrun', '-'], env, encodeStdin: (t) => t }
}

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type {
    AgentRuntimeType,
    GatewayConfig,
    PermissionConfig,
    RuntimeConfig,
    SystemPromptConfig,
} from './types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_DIR = path.resolve(here, '../plugins')
export const TOKEN_PATCH = path.join(PLUGIN_DIR, 'assistant-token-stream.patch.yml')
export const SYSTEM_PROMPT_PATCH = path.join(PLUGIN_DIR, 'system-prompt.patch.yml')
export const SSE_BRIDGE = path.join(PLUGIN_DIR, 'mcp-sse-bridge.mjs')

function stringEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
    const value = env[name]
    return value === undefined || value === '' ? undefined : value
}

function bool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value === '') return fallback
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function int(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10)
    return Number.isFinite(parsed) ? parsed : fallback
}

/** Split an ACP_ARGS string, honoring single/double quotes. */
export function splitArgs(text: string): string[] {
    const result: string[] = []
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
    for (const match of text.matchAll(pattern)) {
        result.push(match[1] ?? match[2] ?? match[3] ?? '')
    }
    return result
}

function jsonObject(value: string | undefined): Record<string, string> {
    if (value === undefined || value === '') return {}
    try {
        const parsed = JSON.parse(value) as Record<string, unknown>
        const result: Record<string, string> = {}
        for (const [key, item] of Object.entries(parsed)) {
            if (typeof item === 'string') result[key] = item
        }
        return result
    } catch {
        return {}
    }
}

export function loadDotEnv(file = '.env'): void {
    try {
        // Node >= 20.12; inherited process.env wins over the file.
        ;(process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile?.(file)
    } catch {
        // Missing .env is normal in container deployments.
    }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
    loadDotEnv()

    const command =
        stringEnv(env, 'DSH_ACP_COMMAND') ??
        (process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    const argsText = stringEnv(env, 'DSH_ACP_ARGS')
    const supervisedArgs =
        argsText === undefined
            ? [
                  '--profile',
                  'acp',
                  ...(bool(stringEnv(env, 'DSH_ACP_TOKEN_STREAM'), true)
                      ? ['--patch', TOKEN_PATCH]
                      : []),
                  '--patch',
                  SYSTEM_PROMPT_PATCH,
              ]
            : splitArgs(argsText)

    const workspace =
        stringEnv(env, 'DSH_AGENT_CWD') ??
        stringEnv(env, 'DSH_ACP_CWD') ??
        process.cwd()

    const permissionMode = stringEnv(env, 'DSH_ACP_PERMISSION_MODE') ?? 'callback'
    const permission: PermissionConfig = {
        mode:
            permissionMode === 'allow' ||
            permissionMode === 'reject' ||
            permissionMode === 'cancel'
                ? permissionMode
                : 'callback',
        callbackUrl: stringEnv(env, 'DSH_ACP_APPROVAL_CALLBACK_URL') ?? null,
        headers: jsonObject(stringEnv(env, 'DSH_ACP_APPROVAL_HEADERS')),
        timeoutMs: int(stringEnv(env, 'DSH_ACP_APPROVAL_TIMEOUT_MS'), 300_000),
        fallback:
            stringEnv(env, 'DSH_ACP_PERMISSION_FALLBACK') === 'allow'
                ? 'allow'
                : stringEnv(env, 'DSH_ACP_PERMISSION_FALLBACK') === 'reject'
                  ? 'reject'
                  : 'cancel',
    }

    const gateway: GatewayConfig = {
        enabled:
            stringEnv(env, 'DSH_AGENTARTS_GATEWAY_ENABLED') === undefined
                ? undefined
                : bool(stringEnv(env, 'DSH_AGENTARTS_GATEWAY_ENABLED'), false),
        mcpUrl: stringEnv(env, 'DSH_AGENTARTS_GATEWAY_MCP_URL'),
        gatewayId: stringEnv(env, 'DSH_AGENTARTS_GATEWAY_ID'),
        targetId: stringEnv(env, 'DSH_AGENTARTS_GATEWAY_TARGET_ID'),
        targetName: stringEnv(env, 'DSH_AGENTARTS_GATEWAY_TARGET_NAME'),
        serverName: stringEnv(env, 'DSH_AGENTARTS_GATEWAY_SERVER_NAME') ?? 'agentarts-gateway',
        serverType: stringEnv(env, 'DSH_AGENTARTS_GATEWAY_SERVER_TYPE'),
        transport:
            stringEnv(env, 'DSH_AGENTARTS_GATEWAY_TRANSPORT') === 'http'
                ? 'http'
                : stringEnv(env, 'DSH_AGENTARTS_GATEWAY_TRANSPORT') === 'sse'
                  ? 'sse'
                  : 'auto',
        headers: jsonObject(stringEnv(env, 'DSH_AGENTARTS_GATEWAY_HEADERS')),
        apiKey: stringEnv(env, 'DSH_AGENTARTS_GATEWAY_API_KEY'),
        apiKeyHeader: stringEnv(env, 'DSH_AGENTARTS_GATEWAY_API_KEY_HEADER'),
        bearerToken: stringEnv(env, 'DSH_AGENTARTS_GATEWAY_BEARER_TOKEN'),
        accessToken: stringEnv(env, 'DSH_AGENTARTS_GATEWAY_ACCESS_TOKEN'),
        accessTokenHeader: stringEnv(env, 'DSH_AGENTARTS_GATEWAY_ACCESS_TOKEN_HEADER'),
        userId: stringEnv(env, 'DSH_AGENTARTS_GATEWAY_USER_ID'),
        userIdHeader: stringEnv(env, 'DSH_AGENTARTS_GATEWAY_USER_ID_HEADER'),
        cacheTtlMs: int(stringEnv(env, 'DSH_AGENTARTS_GATEWAY_CACHE_TTL_MS'), 300_000),
        useAuthorizerKey: bool(stringEnv(env, 'DSH_AGENTARTS_GATEWAY_USE_AUTHORIZER_KEY'), true),
    }

    const systemText = stringEnv(env, 'DSH_SYSTEM_PROMPT')
    const systemModeRaw = stringEnv(env, 'DSH_SYSTEM_PROMPT_MODE')
    const systemPrompt: SystemPromptConfig | undefined =
        systemText === undefined
            ? undefined
            : {
                  text: systemText,
                  mode:
                      systemModeRaw === 'replace' || systemModeRaw === 'replace-all'
                          ? systemModeRaw
                          : 'append',
              }
    const agentRuntimeType = (stringEnv(env, 'AGENT_RUNTIME_TYPE') || 'DSH') as AgentRuntimeType

    return {
        acpCommand: command,
        acpArgs: supervisedArgs,
        workspaceCwd: path.resolve(workspace),
        acpEnv: jsonObject(stringEnv(env, 'DSH_ACP_CHILD_ENV')),
        requestTimeoutMs: int(stringEnv(env, 'DSH_ACP_REQUEST_TIMEOUT_MS'), 60_000),
        verbose: bool(stringEnv(env, 'DSH_ACP_VERBOSE'), false),
        model: stringEnv(env, 'DSH_ACP_MODEL'),
        reasoningEffort: stringEnv(env, 'DSH_ACP_REASONING_EFFORT'),
        systemPrompt,
        permission,
        gateway,
        tokenStream: bool(stringEnv(env, 'DSH_ACP_TOKEN_STREAM'), true),
        sessionTtlMs: int(stringEnv(env, 'DSH_ACP_SESSION_TTL_MS'), 30 * 60_000),
        promptTimeoutMs: int(stringEnv(env, 'DSH_ACP_PROMPT_TIMEOUT_MS'), 600_000),
        queueTimeoutMs: int(stringEnv(env, 'DSH_ACP_QUEUE_TIMEOUT_MS'), 60_000),
        maxConcurrency: int(
            stringEnv(env, 'AGENTRUN_MAX_CONCURRENCY') ?? stringEnv(env, 'DSH_ACP_MAX_CONCURRENCY'),
            15,
        ),
        host: stringEnv(env, 'AGENTARTS_BIND_IP') ?? stringEnv(env, 'HOST') ?? null,
        port: int(stringEnv(env, 'PORT'), 8080),
        logLevel: stringEnv(env, 'DSH_ACP_LOG_LEVEL') ?? 'info',
        agentRuntimeType,
    }
}

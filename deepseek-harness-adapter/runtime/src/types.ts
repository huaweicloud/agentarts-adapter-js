import type { Frame } from '@agentarts/harness-dsh-shared'

export type JsonObject = Record<string, unknown>

export interface AcpMcpServer extends JsonObject {
    name: string
    type?: 'http'
    command?: string
    args?: string[]
    env?: Array<{ name: string; value: string }>
    url?: string
    headers?: Array<{ name: string; value: string }>
}

export interface PermissionConfig {
    mode: 'allow' | 'reject' | 'cancel' | 'callback'
    callbackUrl: string | null
    headers: Record<string, string>
    timeoutMs: number
    fallback: 'allow' | 'reject' | 'cancel'
}

export interface GatewayAuthConfig {
    apiKey?: string
    apiKeyHeader?: string
    bearerToken?: string
    accessToken?: string
    accessTokenHeader?: string
    userId?: string
    userIdHeader?: string
}

export interface GatewayConfig extends GatewayAuthConfig {
    enabled?: boolean
    mcpUrl?: string
    gatewayId?: string
    targetId?: string
    targetName?: string
    serverName?: string
    serverType?: string
    transport?: 'auto' | 'http' | 'sse'
    headers?: Record<string, string>
    cacheTtlMs?: number
    useAuthorizerKey?: boolean
}

export interface SystemPromptConfig {
    text?: string
    mode?: 'append' | 'replace' | 'replace-all'
}

export interface RuntimeConfig {
    acpCommand: string
    acpArgs: string[]
    /** Session workspace/default cwd. The child process itself uses an isolated cwd. */
    workspaceCwd: string
    acpEnv: Record<string, string>
    requestTimeoutMs: number
    verbose: boolean
    model?: string
    reasoningEffort?: string
    systemPrompt?: SystemPromptConfig
    permission: PermissionConfig
    gateway: GatewayConfig
    tokenStream: boolean
    sessionTtlMs: number
    maxSessions: number
    promptTimeoutMs: number
    queueTimeoutMs: number
    maxConcurrency: number
    host: string | null
    port: number
    logLevel: string
}

export interface TurnRequest {
    sessionId: string
    prompt: string
    cwd?: string
    acpSessionId?: string
    mcpServers?: AcpMcpServer[]
    gateway?: GatewayConfig
    systemPrompt?: string
    systemPromptMode?: 'append' | 'replace' | 'replace-all'
    permission?: Partial<PermissionConfig>
    timeoutMs?: number
}

export interface SessionEntry {
    key: string
    acpSessionId: string
    cwd: string
    mcpServers: AcpMcpServer[]
    createdAt: number
    lastUsedAt: number
    current?: PromptRunLike
}

export interface PromptRunLike {
    cancel(): void
}

export type TextChannel = 'message' | 'thought' | 'user'

export type RuntimeEvent =
    | {
          type: 'session'
          sessionId: string
          acpSessionId: string
          cwd: string
          reused: boolean
          mcpServers: Array<Record<string, unknown>>
      }
    | { type: 'text_start'; channel: TextChannel; messageId: string; token: boolean }
    | {
          type: 'text_delta'
          channel: TextChannel
          delta: string
          messageId: string
          token: boolean
      }
    | { type: 'text_end'; channel: TextChannel; messageId: string }
    | {
          type: 'text_correction'
          channel: TextChannel
          text: string
          messageId: string
          reason: string
      }
    | Record<string, unknown> & { type: 'tool_call' | 'tool_call_update' | 'usage' | 'update' }
    | {
          type: 'permission_request'
          requestId: string
          sessionId: string
          acpSessionId: string
          toolCall: unknown
          options: unknown[]
          expiresAt: number
      }
    | {
          type: 'permission_resolved'
          requestId: string
          decision: string
          optionId: string | null
          source: string
      }
    | { type: 'error'; code: string; message: string; statusCode?: number; data?: unknown }
    | { type: 'run_finished'; stopReason: string; output: string; thought: string }

export interface TurnResult {
    ok: boolean
    output: string
    thought: string
    stopReason: string
    sessionId: string
    acpSessionId: string
    cwd: string
    error: { code: string; message: string; statusCode?: number; data?: unknown } | null
    frames?: Frame[]
}

export interface TurnHandle {
    events: AsyncIterable<RuntimeEvent>
    result: Promise<TurnResult>
    cancel(): void
}

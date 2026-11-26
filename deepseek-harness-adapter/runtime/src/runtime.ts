import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { AcpClient } from './acp-client.js'
import { AsyncQueue } from './async-queue.js'
import { RuntimeError, toRuntimeError } from './errors.js'
import {
    GatewayResolver,
    describeMcpServers,
    mergeMcpServers,
    normalizeMcpServers,
} from './gateway.js'
import { PermissionBroker, permissionOutcome, type PermissionOption } from './permission.js'
import { SystemPromptStore, normalizeSystemPromptMode } from './prompt.js'
import type {
    AcpMcpServer,
    RuntimeConfig,
    RuntimeEvent,
    SessionEntry,
    TextChannel,
    TurnHandle,
    TurnRequest,
    TurnResult,
} from './types.js'

interface TextState {
    messageId: string
    token: boolean
    text: string
    committed: string
}

interface PromptRunHooks {
    onUpdate(update: Record<string, unknown>): void
    onPermission(params: Record<string, unknown>): Promise<unknown>
}

/** Owns one `dsh acp` child process and all ACP sessions multiplexed over it. */
export class AcpRuntime {
    readonly config: RuntimeConfig
    private client: AcpClient | null = null
    private clientPromise: Promise<AcpClient> | null = null
    private readonly sessions = new Map<string, SessionEntry>()
    private readonly byAcp = new Map<string, SessionEntry>()
    private readonly queues = new Map<string, Promise<void>>()
    private readonly runnerDir: string
    private readonly promptStore: SystemPromptStore
    private readonly gateway: GatewayResolver
    private permissionBroker: PermissionBroker
    private disposed = false

    constructor(config: RuntimeConfig) {
        this.config = config
        this.runnerDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-runtime-'))
        this.promptStore = new SystemPromptStore()
        this.gateway = new GatewayResolver(config.gateway)
        this.permissionBroker = new PermissionBroker(config.permission)
    }

    get sessionsCount(): number {
        return this.sessions.size
    }

    async start(): Promise<void> {
        await this.ensureClient()
    }

    /** List resumable DSH sessions, optionally scoped to a workspace. */
    async listSessions(input: { cwd?: string; cursor?: string } = {}): Promise<{
        sessions: Array<{ sessionId: string; cwd?: string; title?: string; updatedAt?: string }>
        nextCursor?: string | null
    }> {
        const client = await this.ensureClient()
        return client.listSessions(input)
    }

    /** Close one runtime session and its DSH persistence handle. */
    async closeSession(key: string): Promise<boolean> {
        const entry = this.sessions.get(key)
        if (entry === undefined) return false
        entry.current?.cancel()
        const client = await this.ensureClient()
        try {
            await client.closeSession(entry.acpSessionId)
        } catch {
            // The child may have restarted; removing the in-memory mapping is
            // still the useful outcome.
        }
        this.sessions.delete(key)
        this.byAcp.delete(entry.acpSessionId)
        this.promptStore.remove(entry.acpSessionId)
        return true
    }

    /** Cancel the in-flight turn of a runtime session. */
    cancelSession(key: string): boolean {
        const entry = this.sessions.get(key)
        if (entry?.current === undefined) return false
        entry.current.cancel()
        return true
    }

    /** Change model/reasoning/arbitrary ACP config for one session. */
    async setConfig(
        key: string,
        values: { model?: string; reasoningEffort?: string; configOptions?: Array<{ configId: string; value: string }> },
    ): Promise<{ sessionId: string; applied: string[] }> {
        const entry = this.sessions.get(key)
        if (entry === undefined) {
            throw new RuntimeError(`session not found: ${key}`, {
                code: 'session_not_found',
                statusCode: 404,
            })
        }
        const client = await this.ensureClient()
        const applied: string[] = []
        if (values.model !== undefined) {
            await client.setConfigOption(entry.acpSessionId, 'model', values.model)
            applied.push('model')
        }
        if (values.reasoningEffort !== undefined) {
            await client.setConfigOption(
                entry.acpSessionId,
                'reasoning_effort',
                values.reasoningEffort,
            )
            applied.push('reasoning_effort')
        }
        for (const option of values.configOptions ?? []) {
            await client.setConfigOption(entry.acpSessionId, option.configId, option.value)
            applied.push(option.configId)
        }
        return { sessionId: key, applied }
    }

    async runTurn(request: TurnRequest, signal?: AbortSignal): Promise<TurnHandle> {
        if (this.disposed) {
            throw new RuntimeError('runtime is shutting down', {
                code: 'shutting_down',
                statusCode: 503,
            })
        }
        const release = await this.acquire(request.sessionId, signal)
        try {
            const reused = this.sessions.has(request.sessionId)
            const entry = await this.openSession(request)
            const client = await this.ensureClient()
            const queue = new AsyncQueue<RuntimeEvent>()
            const permissionBroker =
                request.permission === undefined
                    ? this.permissionBroker
                    : new PermissionBroker({
                          ...this.config.permission,
                          ...request.permission,
                      })
            const run = new PromptRun({
                runtime: this,
                client,
                entry,
                request,
                reused,
                promptStore: this.promptStore,
                permissionBroker,
                queue,
            })
            entry.current = run
            const result = run.start().finally(() => {
                entry.lastUsedAt = Date.now()
                entry.current = undefined
                release()
            })
            return {
                events: queue,
                result,
                cancel: () => run.cancel(),
            }
        } catch (error) {
            this.prune()
            release()
            throw error
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) return
        this.disposed = true
        for (const entry of this.sessions.values()) {
            this.promptStore.remove(entry.acpSessionId)
        }
        this.sessions.clear()
        this.byAcp.clear()
        const client = this.client
        this.client = null
        this.clientPromise = null
        if (client !== null) await client.dispose()
        this.promptStore.dispose()
        rmSync(this.runnerDir, { recursive: true, force: true })
    }

    /** Called by PromptRun when the ACP prompt request settles. */
    complete(entry: SessionEntry): void {
        entry.lastUsedAt = Date.now()
    }

    private async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
        const previous = this.queues.get(key) ?? Promise.resolve()
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const tail = previous.then(() => gate)
        this.queues.set(key, tail)
        if (signal?.aborted === true) {
            release()
            if (this.queues.get(key) === tail) this.queues.delete(key)
            throw new RuntimeError('round cancelled before start', {
                code: 'cancelled',
                statusCode: 499,
            })
        }
        await previous
        return () => {
            release()
            if (this.queues.get(key) === tail) this.queues.delete(key)
        }
    }

    private async ensureClient(): Promise<AcpClient> {
        if (this.client !== null && this.client.running) return this.client
        if (this.clientPromise !== null) return this.clientPromise
        if (this.disposed) {
            throw new RuntimeError('runtime is shutting down', {
                code: 'shutting_down',
                statusCode: 503,
            })
        }
        const client = new AcpClient({
            command: this.config.acpCommand,
            args: this.config.acpArgs,
            cwd: this.runnerDir,
            env: {
                ...this.config.acpEnv,
                DSH_ACP_TOKEN_STREAM: this.config.tokenStream ? '1' : '0',
                DSH_SYSTEM_PROMPT_DIR: this.promptStore.dir,
            },
            requestTimeoutMs: this.config.requestTimeoutMs,
            verbose: this.config.verbose,
        })
        client.onNotification('session/update', (params) => this.routeUpdate(params))
        client.onRequest('session/request_permission', (params) =>
            this.routePermission(params),
        )
        client.onClosed(() => {
            // 旧 client 迟到的 close 不得清掉新 client 的会话与事件路由
            if (this.client !== client) return
            this.client = null
            this.clientPromise = null
            this.sessions.clear()
            this.byAcp.clear()
        })
        this.client = client
        this.clientPromise = (async () => {
            await client.start()
            await client.initialize()
            return client
        })().catch(async (error) => {
            // 先等本次创建的 child 释放完，再允许新建 client；只清本次创建的引用
            await client.dispose().catch(() => undefined)
            if (this.client === client) {
                this.client = null
                this.clientPromise = null
            }
            throw error
        })
        return this.clientPromise
    }

    private async openSession(request: TurnRequest): Promise<SessionEntry> {
        const existing = this.sessions.get(request.sessionId)
        const cwd = path.resolve(request.cwd ?? this.config.workspaceCwd)
        if (existing !== undefined) {
            if (existing.cwd !== cwd) {
                throw new RuntimeError('session cwd mismatch', {
                    code: 'session_cwd_mismatch',
                    statusCode: 409,
                })
            }
            return existing
        }

        const client = await this.ensureClient()
        let mcpServers = normalizeMcpServers(request.mcpServers)
        // Merge deployment-level mcpServers (agent_metadata.mcp_config supports multiple gateways).
        const deployed = readDeployedMcpServers()
        if (deployed.length > 0) {
            mcpServers = mergeMcpServers(mcpServers, deployed)
        }
        const gateway = await this.gateway.resolve(request.gateway ?? {})
        if (gateway !== null) {
            mcpServers = mergeMcpServers(mcpServers, [gateway.server])
        }

        let info: { sessionId: string; configOptions?: unknown }
        if (request.acpSessionId !== undefined) {
            info = await client.resumeSession({
                sessionId: request.acpSessionId,
                cwd,
                mcpServers: mcpServers as unknown as Record<string, unknown>[],
            })
        } else {
            info = await client.newSession({
                cwd,
                mcpServers: mcpServers as unknown as Record<string, unknown>[],
            })
        }

        const entry: SessionEntry = {
            key: request.sessionId,
            acpSessionId: info.sessionId,
            cwd,
            mcpServers,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
        }
        this.sessions.set(entry.key, entry)
        this.byAcp.set(entry.acpSessionId, entry)
        await this.applyModelConfig(client, entry, info.configOptions)
        this.prune()
        return entry
    }

    private async applyModelConfig(
        client: AcpClient,
        entry: SessionEntry,
        configOptions: unknown,
    ): Promise<void> {
        const options = Array.isArray(configOptions) ? configOptions : []
        const find = (id: string): { id: string; value: string } | null => {
            const option = options.find(
                (item) =>
                    item !== null &&
                    typeof item === 'object' &&
                    (item as Record<string, unknown>).id === id,
            ) as Record<string, unknown> | undefined
            if (option === undefined) return null
            const current = option.currentValue
            const groups = Array.isArray(option.options) ? option.options : []
            // configOptions 的 options 可能是 group 嵌套（每项含 group/options 子数组），
            // 也可能是扁平选项（每项含 value/name）。两种都要能按模型名匹配到具体的 ACP value。
            for (const group of groups) {
                if (group === null || typeof group !== 'object') continue
                const candidates = Array.isArray((group as Record<string, unknown>).options)
                    ? ((group as Record<string, unknown>).options as unknown[])
                    : [group]
                for (const candidate of candidates) {
                    if (candidate === null || typeof candidate !== 'object') continue
                    const value = (candidate as Record<string, unknown>).value
                    const name = (candidate as Record<string, unknown>).name
                    if (value === this.config.model || name === this.config.model) {
                        return {
                            id,
                            value: String(value ?? current ?? this.config.model ?? ''),
                        }
                    }
                }
            }
            return {
                id,
                value: String(current ?? this.config.model ?? ''),
            }
        }
        const model = this.config.model === undefined ? null : find('model')
        if (model !== null && model.value !== '') {
            await client.setConfigOption(entry.acpSessionId, 'model', model.value)
        }
        if (this.config.reasoningEffort !== undefined) {
            await client.setConfigOption(
                entry.acpSessionId,
                'reasoning_effort',
                this.config.reasoningEffort,
            )
        }
    }

    private routeUpdate(params: unknown): void {
        const record = params as { sessionId?: unknown; update?: unknown } | null
        if (record === null || typeof record.sessionId !== 'string') return
        const entry = this.byAcp.get(record.sessionId)
        const run = entry?.current as unknown as PromptRunHooks | undefined
        if (run !== undefined && record.update !== null && typeof record.update === 'object') {
            run.onUpdate(record.update as Record<string, unknown>)
        }
    }

    private async routePermission(params: unknown): Promise<unknown> {
        const record = params as { sessionId?: unknown } | null
        const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : null
        const entry = sessionId === null ? undefined : this.byAcp.get(sessionId)
        const run = entry?.current as unknown as PromptRunHooks | undefined
        if (run === undefined) {
            return { outcome: { outcome: 'cancelled' } }
        }
        return run.onPermission((params ?? {}) as Record<string, unknown>)
    }

    private prune(): void {
        const now = Date.now()
        for (const [key, entry] of this.sessions) {
            if (entry.current !== undefined) continue
            if (now - entry.lastUsedAt <= this.config.sessionTtlMs) continue
            this.sessions.delete(key)
            this.byAcp.delete(entry.acpSessionId)
            this.promptStore.remove(entry.acpSessionId)
        }
    }
}

interface PromptRunOptions {
    runtime: AcpRuntime
    client: AcpClient
    entry: SessionEntry
    request: TurnRequest
    reused: boolean
    promptStore: SystemPromptStore
    permissionBroker: PermissionBroker
    queue: AsyncQueue<RuntimeEvent>
}

class PromptRun implements PromptRunHooks {
    private readonly runtime: AcpRuntime
    private readonly client: AcpClient
    private readonly entry: SessionEntry
    private readonly request: TurnRequest
    private readonly reused: boolean
    private readonly promptStore: SystemPromptStore
    private readonly permissionBroker: PermissionBroker
    private readonly queue: AsyncQueue<RuntimeEvent>
    private readonly text = new Map<TextChannel, TextState>()
    private readonly messages = new Map<string, unknown>()
    private controller = new AbortController()
    private settled = false
    private cancelled = false
    private timedOut = false
    private readonly runId = randomUUID()
    private timer: NodeJS.Timeout | null = null

    constructor(options: PromptRunOptions) {
        this.runtime = options.runtime
        this.client = options.client
        this.entry = options.entry
        this.request = options.request
        this.reused = options.reused
        this.promptStore = options.promptStore
        this.permissionBroker = options.permissionBroker
        this.queue = options.queue
    }

    async start(): Promise<TurnResult> {
        try {
            const prompt = this.request.systemPrompt ?? this.runtime.config.systemPrompt?.text
            if (prompt !== undefined && prompt.trim() !== '') {
                this.promptStore.write(
                    this.entry.acpSessionId,
                    prompt,
                    this.request.systemPromptMode ??
                        this.runtime.config.systemPrompt?.mode ??
                        'append',
                )
            } else {
                this.promptStore.remove(this.entry.acpSessionId)
            }

            this.emit({
                type: 'session',
                sessionId: this.entry.key,
                acpSessionId: this.entry.acpSessionId,
                cwd: this.entry.cwd,
                reused: this.reused,
                mcpServers: describeMcpServers(this.entry.mcpServers),
            })
            this.emit({
                type: 'run_started',
                runId: this.runId,
                requestId: randomUUID(),
                sessionId: this.entry.key,
                acpSessionId: this.entry.acpSessionId,
            })

            const timeoutMs = this.request.timeoutMs ?? this.runtime.config.promptTimeoutMs
            this.timer = setTimeout(() => {
                this.timedOut = true
                this.cancelled = true
                this.client.cancel(this.entry.acpSessionId)
            }, timeoutMs)

            const result = await this.client.prompt(this.entry.acpSessionId, [
                { type: 'text', text: this.request.prompt },
            ])
            const stopReason = result?.stopReason ?? 'end_turn'
            const output = this.finalText('message')
            const thought = this.finalText('thought')
            for (const [channel, state] of this.text) {
                if (state.token && state.committed !== '' && state.committed !== state.text) {
                    this.emit({
                        type: 'text_correction',
                        channel,
                        text: state.committed,
                        messageId: state.messageId,
                        reason: 'token/committed divergence',
                    })
                }
                this.emit({ type: 'text_end', channel, messageId: state.messageId })
            }
            this.emit({ type: 'run_finished', stopReason, output, thought })
            this.queue.end()
            return {
                ok: true,
                output,
                thought,
                stopReason,
                sessionId: this.entry.key,
                acpSessionId: this.entry.acpSessionId,
                cwd: this.entry.cwd,
                error: null,
            }
        } catch (error) {
            const runtimeError = toRuntimeError(error)
            const code = this.timedOut
                ? 'prompt_timeout'
                : this.cancelled
                  ? 'cancelled'
                  : runtimeError.code
            const message = this.timedOut
                ? 'prompt timed out'
                : this.cancelled
                  ? 'prompt cancelled'
                  : runtimeError.message
            const stopReason = this.timedOut
                ? 'timeout'
                : this.cancelled
                  ? 'cancelled'
                  : 'error'
            this.emit({
                type: 'error',
                code,
                message,
                statusCode: this.timedOut ? 504 : runtimeError.statusCode,
                data: runtimeError.data,
            })
            this.emit({
                type: 'run_finished',
                stopReason,
                output: this.finalText('message'),
                thought: this.finalText('thought'),
            })
            this.queue.end()
            return {
                ok: false,
                output: this.finalText('message'),
                thought: this.finalText('thought'),
                stopReason,
                sessionId: this.entry.key,
                acpSessionId: this.entry.acpSessionId,
                cwd: this.entry.cwd,
                error: {
                    code,
                    message,
                    statusCode: this.timedOut ? 504 : runtimeError.statusCode,
                    data: runtimeError.data,
                },
            }
        } finally {
            if (this.timer !== null) clearTimeout(this.timer)
            this.settled = true
            this.promptStore.remove(this.entry.acpSessionId)
            this.runtime.complete(this.entry)
        }
    }

    onUpdate(update: Record<string, unknown>): void {
        if (this.settled) return
        const kind = update.sessionUpdate
        const tokenMeta = update._meta as Record<string, unknown> | undefined
        const isToken = tokenMeta?.['dsh-acp/token'] === true

        if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
            const channel: TextChannel =
                kind === 'agent_thought_chunk' ? 'thought' : 'message'
            const text = textOf(update.content)
            if (text === '') return
            let state = this.text.get(channel)
            if (state === undefined) {
                state = {
                    messageId:
                        typeof update.messageId === 'string'
                            ? update.messageId
                            : `token-${randomUUID()}`,
                    token: isToken,
                    text: '',
                    committed: '',
                }
                this.text.set(channel, state)
                this.emit({
                    type: 'text_start',
                    channel,
                    messageId: state.messageId,
                    token: isToken,
                })
            }
            if (isToken) {
                state.token = true
                state.text += text
                this.emit({
                    type: 'text_delta',
                    channel,
                    delta: text,
                    messageId: state.messageId,
                    token: true,
                })
            } else {
                state.committed += text
                if (!state.token) {
                    state.text += text
                    this.emit({
                        type: 'text_delta',
                        channel,
                        delta: text,
                        messageId: state.messageId,
                        token: false,
                    })
                }
            }
            return
        }

        if (kind === 'tool_call') {
            const callId = String(update.toolCallId ?? randomUUID())
            this.messages.set(callId, update)
            this.emit({
                type: 'tool_call',
                toolCallId: callId,
                title: update.title,
                name: update.name,
                kind: update.kind,
                status: update.status,
                content: update.content,
                rawInput: update.rawInput,
            })
            return
        }

        if (kind === 'tool_call_update') {
            const callId = String(update.toolCallId ?? '')
            this.emit({
                type: 'tool_call_update',
                toolCallId: callId,
                status: update.status,
                content: update.content,
                rawOutput: update.rawOutput,
            })
            return
        }

        if (kind === 'usage_update') {
            this.emit({ type: 'usage', used: update.used, size: update.size })
            return
        }

        this.emit({ type: 'update', sessionUpdate: kind, update })
    }

    async onPermission(params: Record<string, unknown>): Promise<unknown> {
        const options = (Array.isArray(params.options) ? params.options : []) as PermissionOption[]
        const requestId =
            typeof (params.toolCall as { toolCallId?: unknown } | undefined)?.toolCallId ===
            'string'
                ? String((params.toolCall as { toolCallId: string }).toolCallId)
                : randomUUID()
        this.emit({
            type: 'permission_request',
            requestId,
            sessionId: this.entry.key,
            acpSessionId: this.entry.acpSessionId,
            toolCall: params.toolCall,
            options,
            expiresAt: Date.now() + this.runtime.config.permission.timeoutMs,
        })
        const decision = await this.permissionBroker.decide(
            {
                requestId,
                sessionId: this.entry.key,
                toolCall: params.toolCall,
                options,
            },
            this.controller.signal,
        )
        this.emit({
            type: 'permission_resolved',
            requestId,
            decision: decision.decision,
            optionId: decision.optionId,
            source: decision.source,
        })
        return permissionOutcome(decision)
    }

    cancel(): void {
        if (this.settled) return
        this.cancelled = true
        this.controller.abort()
        this.client.cancel(this.entry.acpSessionId)
    }

    private finalText(channel: TextChannel): string {
        const state = this.text.get(channel)
        if (state === undefined) return ''
        return state.committed !== '' ? state.committed : state.text
    }

    private emit(event: RuntimeEvent): void {
        this.queue.push(event)
    }
}

function textOf(content: unknown): string {
    if (typeof content === 'string') return content
    if (content === null || typeof content !== 'object') return ''
    const record = content as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (Array.isArray(record.content)) {
        return record.content
            .map((item) =>
                item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string'
                    ? String((item as Record<string, unknown>).text)
                    : '',
            )
            .join('')
    }
    return ''
}

export { normalizeSystemPromptMode }

/**
 * Read deployment-level MCP servers injected by the Adapter's agent_metadata translation
 * layer (AGENTRUN_ACP_MCP_SERVERS). Supports multiple gateways; returns [] when unset.
 */
function readDeployedMcpServers(): AcpMcpServer[] {
    const raw = process.env.AGENTRUN_ACP_MCP_SERVERS
    if (raw === undefined || raw.trim() === '') return []
    try {
        const parsed = JSON.parse(raw) as unknown
        return Array.isArray(parsed) ? (parsed as AcpMcpServer[]) : []
    } catch {
        return []
    }
}

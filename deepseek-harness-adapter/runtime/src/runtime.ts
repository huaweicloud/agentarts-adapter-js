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

function cancelledBeforeStart(): RuntimeError {
    return new RuntimeError('round cancelled before prompt', { code: 'cancelled', statusCode: 499 })
}

/** An aborted caller can leave shared setup running. No session/prompt RPC is detached. */
async function waitForSetup<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(cancelledBeforeStart())
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
    })
    try { return await Promise.race([work, cancelled]) }
    finally { signal.removeEventListener('abort', abort) }
}

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
    private readonly queues = new Map<string, Set<() => void>>()
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

    private initialized = false

    get ready(): boolean { return this.initialized && this.client?.running === true }

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
        await this.retireSession(entry, await this.ensureClient())
        return true
    }

    async retireSession(entry: SessionEntry, client: AcpClient): Promise<void> {
        entry.quarantined = true
        await client.closeSession(entry.acpSessionId)
        if (this.sessions.get(entry.key) === entry) {
            this.sessions.delete(entry.key)
            this.byAcp.delete(entry.acpSessionId)
            this.promptStore.remove(entry.acpSessionId)
        }
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
            const checkCancelled = () => { if (signal?.aborted) throw cancelledBeforeStart() }
            checkCancelled()
            const reused = this.sessions.has(request.sessionId)
            const entry = await this.openSession(request, signal)
            const client = await this.ensureClient()
            checkCancelled()
            if (this.sessions.get(request.sessionId) !== entry || entry.quarantined) {
                throw new RuntimeError('session closed during preparation', { code: 'session_unavailable', statusCode: 503 })
            }
            const queue = new AsyncQueue<RuntimeEvent>(request.stream !== false)
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
            const cancel = () => run.cancel()
            signal?.addEventListener('abort', cancel, { once: true })
            const result = run.start().finally(() => {
                signal?.removeEventListener('abort', cancel)
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
        if (signal?.aborted) throw cancelledBeforeStart()
        let waiters = this.queues.get(key)
        if (waiters === undefined) {
            waiters = new Set()
            this.queues.set(key, waiters)
        } else {
            const queue = waiters
            await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    queue.delete(admit)
                    clearTimeout(timer)
                    signal?.removeEventListener('abort', abort)
                }
                const admit = () => { cleanup(); resolve() }
                const abort = () => { cleanup(); reject(cancelledBeforeStart()) }
                const timer = setTimeout(() => {
                    cleanup()
                    reject(new RuntimeError('session queue timed out', { code: 'queue_timeout', statusCode: 503 }))
                }, this.config.queueTimeoutMs)
                queue.add(admit)
                signal?.addEventListener('abort', abort, { once: true })
            })
        }
        return () => {
            const next = waiters.values().next().value
            if (next) next()
            else this.queues.delete(key)
        }
    }

    private async ensureClient(): Promise<AcpClient> {
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
            this.initialized = false
            this.client = null
            this.clientPromise = null
            this.sessions.clear()
            this.byAcp.clear()
        })
        this.client = client
        this.clientPromise = (async () => {
            await client.start()
            const hello = await client.initialize() as { protocolVersion?: number } | null
            if (hello?.protocolVersion !== 1) throw new RuntimeError('ACP version 1 handshake required', { statusCode: 502 })
            this.initialized = true
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

    private async openSession(request: TurnRequest, signal?: AbortSignal): Promise<SessionEntry> {
        const existing = this.sessions.get(request.sessionId)
        const cwd = path.resolve(request.cwd ?? this.config.workspaceCwd)
        if (existing !== undefined) {
            if (existing.quarantined) throw new RuntimeError('session cleanup required', {
                code: 'session_unavailable', statusCode: 503,
            })
            if (existing.cwd !== cwd) {
                throw new RuntimeError('session cwd mismatch', {
                    code: 'session_cwd_mismatch',
                    statusCode: 409,
                })
            }
            return existing
        }

        if (request.acpSessionId && this.byAcp.has(request.acpSessionId)) {
            throw new RuntimeError('ACP session is already attached', { code: 'session_conflict', statusCode: 409 })
        }
        const client = await waitForSetup(this.ensureClient(), signal)
        if (signal?.aborted) throw cancelledBeforeStart()
        let mcpServers = normalizeMcpServers(request.mcpServers)
        const gateway = await waitForSetup(this.gateway.resolve(request.gateway ?? {}), signal)
        if (gateway !== null) {
            mcpServers = mergeMcpServers(mcpServers, [gateway.server])
        }

        if (signal?.aborted) throw cancelledBeforeStart()
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
        try {
            if (signal?.aborted) throw cancelledBeforeStart()
            await this.applyModelConfig(client, entry, info.configOptions)
            if (signal?.aborted) throw cancelledBeforeStart()
        } catch (error) {
            await client.closeSession(entry.acpSessionId).catch(() => {})
            throw error
        }
        this.sessions.set(entry.key, entry)
        this.byAcp.set(entry.acpSessionId, entry)
        this.prune()
        return entry
    }

    private async applyModelConfig(
        client: AcpClient,
        entry: SessionEntry,
        configOptions: unknown,
    ): Promise<void> {
        const model = this.config.model
        if (model) {
            const options = Array.isArray(configOptions) ? configOptions : []
            const selector = options.find(option => option?.id === 'model')
            // rc.3 encodes the provider and model together as the opaque selection value.
            const official = JSON.stringify(['deepseek-official', model])
            const groups: Array<{ value?: string; name?: string; options?: Array<{ value: string; name?: string }> }> =
                selector?.options ?? []
            const values = groups.flatMap(group => group.options ?? (group.value ? [{ name: group.name, value: group.value }] : []))
            const selection = values.find(item => item.value === model || item.value === official)
                ?? values.find(item => item.name === model)
            if (!selection) throw new RuntimeError('Configured model is unavailable in the ACP session', {
                code: 'model_unavailable', statusCode: 502,
            })
            if (selection.value !== selector.currentValue) {
                await client.setConfigOption(entry.acpSessionId, 'model', selection.value)
            }
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
        for (const entry of this.sessions.values()) {
            if (entry.current !== undefined || entry.quarantined) continue
            if (now - entry.lastUsedAt <= this.config.sessionTtlMs) continue
            if (this.client?.running) {
                // Closing is asynchronous. Keep the mapping quarantined until the backend confirms.
                void this.retireSession(entry, this.client).catch(() => {})
            }
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
    private overflow = false
    private controller = new AbortController()
    private settled = false
    private cancelled = false
    private timedOut = false
    private readonly runId = randomUUID()
    private timer: NodeJS.Timeout | null = null
    private grace?: NodeJS.Timeout
    private readonly promptDeadline = new AbortController()

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
                if (!this.cancelled) {
                    this.timedOut = true
                    this.cancel()
                }
            }, timeoutMs)

            const result = await this.client.prompt(this.entry.acpSessionId, [
                { type: 'text', text: this.request.prompt },
            ], this.promptDeadline.signal)
            if (this.cancelled || result?.stopReason === 'cancelled') {
                this.cancelled = true
                throw new RuntimeError('prompt cancelled', { code: 'cancelled', statusCode: 499 })
            }
            if (!result?.stopReason) throw new RuntimeError('missing ACP stopReason', { statusCode: 502 })
            const stopReason = result.stopReason
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
            if (this.overflow) throw new RuntimeError('round event buffer limit exceeded')
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
            if (this.promptDeadline.signal.aborted) {
                await this.runtime.retireSession(this.entry, this.client).catch(() => {
                    // Keep the session quarantined until explicit close succeeds or the client exits.
                })
            }
            const runtimeError = toRuntimeError(error)
            let stopReason = 'error'
            let failure = runtimeError
            if (this.overflow) {
                failure = new RuntimeError('round event buffer limit exceeded', { code: 'output_limit', statusCode: 503 })
            } else if (this.timedOut) {
                stopReason = 'timeout'
                failure = new RuntimeError('prompt timed out', { code: 'prompt_timeout', statusCode: 504 })
            } else if (this.cancelled) {
                stopReason = 'cancelled'
                failure = new RuntimeError('prompt cancelled', { code: 'cancelled', statusCode: 499 })
            }
            const { code, message, statusCode, data } = failure
            this.emit({
                type: 'error',
                code,
                message,
                statusCode,
                data,
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
                    statusCode,
                    data,
                },
            }
        } finally {
            if (this.timer !== null) clearTimeout(this.timer)
            clearTimeout(this.grace)
            this.settled = true
            this.promptStore.remove(this.entry.acpSessionId)
            this.runtime.complete(this.entry)
        }
    }

    onUpdate(update: Record<string, unknown>): void {
        if (this.settled || this.cancelled) return
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
                    ...(typeof tokenMeta?.attemptId === 'string' ? { attemptId: tokenMeta.attemptId } : {}),
                    ...(typeof tokenMeta?.revision === 'number' ? { revision: tokenMeta.revision } : {}),
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
        if (this.settled || this.cancelled) return
        this.cancelled = true
        this.controller.abort()
        this.grace = setTimeout(() => this.promptDeadline.abort(), 5000)
        if (this.client.running) this.client.cancel(this.entry.acpSessionId)
    }

    private finalText(channel: TextChannel): string {
        const state = this.text.get(channel)
        if (state === undefined) return ''
        return state.committed !== '' ? state.committed : state.text
    }

    private emit(event: RuntimeEvent): void {
        if (!this.queue.push(event) && !this.overflow) {
            this.overflow = true
            this.cancel()
        }
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

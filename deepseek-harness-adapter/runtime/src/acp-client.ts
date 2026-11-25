import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { AcpError } from './errors.js'

type JsonObject = Record<string, unknown>
type NotificationHandler = (params: unknown) => void
type RequestHandler = (params: unknown) => unknown | Promise<unknown>

interface Pending {
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
    timer: NodeJS.Timeout
}

export interface AcpClientOptions {
    command: string
    args: string[]
    cwd: string
    env: Record<string, string>
    requestTimeoutMs: number
    verbose?: boolean
}

export interface AcpSessionInfo {
    sessionId: string
    cwd?: string
    title?: string
    updatedAt?: string
}

/**
 * ACP v1 stdio client: NDJSON JSON-RPC 2.0, request/notification routing,
 * reverse requests (`session/request_permission`) and child lifecycle.
 */
export class AcpClient {
    private child: ChildProcessWithoutNullStreams | null = null
    private nextId = 0
    private pending = new Map<number, Pending>()
    private notifications = new Map<string, Set<NotificationHandler>>()
    private requests = new Map<string, RequestHandler>()
    private stderrTail = ''
    private closed: Error | null = null
    private started = false
    private stopping = false
    private readonly listeners = new Set<(error: Error | null) => void>()

    constructor(private readonly options: AcpClientOptions) {}

    get stderr(): string {
        return this.stderrTail
    }

    get running(): boolean {
        return this.child !== null && this.started && this.closed === null
    }

    onClosed(listener: (error: Error | null) => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    onNotification(method: string, handler: NotificationHandler): () => void {
        let handlers = this.notifications.get(method)
        if (handlers === undefined) {
            handlers = new Set()
            this.notifications.set(method, handlers)
        }
        handlers.add(handler)
        return () => handlers?.delete(handler)
    }

    onRequest(method: string, handler: RequestHandler): () => void {
        this.requests.set(method, handler)
        return () => {
            if (this.requests.get(method) === handler) this.requests.delete(method)
        }
    }

    async start(): Promise<void> {
        if (this.running) return
        this.closed = null
        this.stopping = false
        const command = this.options.command
        const isCmd = process.platform === 'win32' && /\.cmd$/i.test(command)
        const argsText = this.options.args.map(quoteWindows).join(' ')
        const child = isCmd
            ? spawn(
                  process.env.ComSpec ?? 'cmd.exe',
                  [
                      '/d',
                      '/s',
                      '/c',
                      /\s/.test(command)
                          ? `""${command}" ${argsText}"`
                          : `${command} ${argsText}`,
                  ],
                  {
                      cwd: this.options.cwd,
                      env: { ...process.env, ...this.options.env },
                      stdio: ['pipe', 'pipe', 'pipe'],
                  },
              )
            : spawn(command, this.options.args, {
                  cwd: this.options.cwd,
                  env: { ...process.env, ...this.options.env },
                  stdio: ['pipe', 'pipe', 'pipe'],
              })

        this.child = child
        this.started = true
        child.on('error', (error) => this.finish(error))
        child.on('close', (code, signal) => {
            const reason = this.stopping
                ? null
                : new AcpError(
                      `dsh acp exited (code=${code}, signal=${signal})${
                          this.stderrTail === '' ? '' : `; stderr: ${this.stderrTail}`
                      }`,
                      -32000,
                  )
            this.finish(reason)
        })
        child.stderr.on('data', (chunk: Buffer) => {
            this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-16_384)
        })
        const lines = createInterface({ input: child.stdout })
        lines.on('line', (line) => {
            if (this.options.verbose) process.stderr.write(`[acp <-] ${line}\n`)
            void this.handleLine(line)
        })
        child.stdin.on('error', () => undefined)
    }

    async initialize(): Promise<unknown> {
        this.assertRunning()
        return this.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
            },
        })
    }

    async newSession(input: {
        cwd: string
        mcpServers?: JsonObject[]
    }): Promise<{ sessionId: string; configOptions?: unknown }> {
        return (await this.request('session/new', {
            cwd: input.cwd,
            mcpServers: input.mcpServers ?? [],
        })) as { sessionId: string; configOptions?: unknown }
    }

    async resumeSession(input: {
        sessionId: string
        cwd: string
        mcpServers?: JsonObject[]
    }): Promise<{ sessionId: string; configOptions?: unknown }> {
        return (await this.request('session/resume', {
            sessionId: input.sessionId,
            cwd: input.cwd,
            mcpServers: input.mcpServers ?? [],
        })) as { sessionId: string; configOptions?: unknown }
    }

    async listSessions(input: { cwd?: string; cursor?: string } = {}): Promise<{
        sessions: AcpSessionInfo[]
        nextCursor?: string | null
    }> {
        return (await this.request('session/list', {
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        })) as { sessions: AcpSessionInfo[]; nextCursor?: string | null }
    }

    async setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
        return this.request('session/set_config_option', { sessionId, configId, value })
    }

    prompt(sessionId: string, prompt: unknown[]): Promise<{ stopReason?: string }> {
        return this.request('session/prompt', { sessionId, prompt }, 0) as Promise<{
            stopReason?: string
        }>
    }

    notify(method: string, params: JsonObject): void {
        this.write({ jsonrpc: '2.0', method, params })
    }

    cancel(sessionId: string): void {
        this.notify('session/cancel', { sessionId })
    }

    async closeSession(sessionId: string): Promise<unknown> {
        return this.request('session/close', { sessionId })
    }

    request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs): Promise<unknown> {
        this.assertRunning()
        const id = ++this.nextId
        return new Promise((resolve, reject) => {
            const timer =
                timeoutMs > 0
                    ? setTimeout(() => {
                          this.pending.delete(id)
                          reject(new AcpError(`ACP request timeout: ${method}`, -32001))
                      }, timeoutMs)
                    : (undefined as unknown as NodeJS.Timeout)
            this.pending.set(id, { resolve, reject, timer })
            try {
                this.write({ jsonrpc: '2.0', id, method, params })
            } catch (error) {
                if (timeoutMs > 0) clearTimeout(timer)
                this.pending.delete(id)
                reject(error)
            }
        })
    }

    async dispose(): Promise<void> {
        this.stopping = true
        const child = this.child
        this.child = null
        this.started = false
        if (child === null) return
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(new AcpError('ACP client disposed', -32000))
        }
        this.pending.clear()
        child.stdin.end()
        child.kill('SIGTERM')
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                if (child.exitCode === null) child.kill('SIGKILL')
                resolve()
            }, 3_000)
            child.once('close', () => {
                clearTimeout(timer)
                resolve()
            })
        })
    }

    private assertRunning(): void {
        if (!this.running || this.child === null) {
            throw this.closed ?? new AcpError('ACP child is not running', -32000)
        }
    }

    private write(message: JsonObject): void {
        const child = this.child
        if (child === null || child.stdin.destroyed) {
            throw new AcpError('ACP child stdin is closed', -32000)
        }
        if (this.options.verbose) process.stderr.write(`[acp ->] ${JSON.stringify(message)}\n`)
        child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    private async handleLine(line: string): Promise<void> {
        const text = line.trim()
        if (text === '') return
        let message: JsonObject
        try {
            message = JSON.parse(text) as JsonObject
        } catch {
            return
        }

        const method = typeof message.method === 'string' ? message.method : null
        const id = typeof message.id === 'number' ? message.id : null

        if (method !== null && id !== null) {
            // Reverse request from the agent to this client.
            const handler = this.requests.get(method)
            if (handler === undefined) {
                this.write({
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32601, message: `Method not found: ${method}` },
                })
                return
            }
            try {
                const result = await handler(message.params)
                this.write({ jsonrpc: '2.0', id, result: result ?? null })
            } catch (error) {
                this.write({
                    jsonrpc: '2.0',
                    id,
                    error: {
                        code: -32603,
                        message: error instanceof Error ? error.message : String(error),
                    },
                })
            }
            return
        }

        if (id !== null) {
            const pending = this.pending.get(id)
            if (pending === undefined) return
            clearTimeout(pending.timer)
            this.pending.delete(id)
            if (message.error !== undefined) {
                const error = message.error as { code?: number; message?: string; data?: unknown }
                pending.reject(new AcpError(error.message ?? 'ACP error', error.code, error.data))
            } else {
                pending.resolve(message.result)
            }
            return
        }

        if (method !== null) {
            const handlers = this.notifications.get(method)
            if (handlers !== undefined) {
                for (const handler of handlers) handler(message.params)
            }
        }
    }

    private finish(error: Error | null): void {
        if (this.closed !== null) return
        this.closed = error
        this.started = false
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(error ?? new AcpError('ACP child closed', -32000))
        }
        this.pending.clear()
        for (const listener of this.listeners) listener(error)
    }
}

function quoteWindows(value: string): string {
    return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value
}

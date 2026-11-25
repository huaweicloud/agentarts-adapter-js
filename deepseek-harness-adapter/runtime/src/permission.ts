import type { PermissionConfig } from './types.js'

export interface PermissionOption {
    optionId: string
    name?: string
    kind?: string
}

export interface PermissionRequest {
    requestId: string
    sessionId: string
    toolCall: unknown
    options: PermissionOption[]
}

export interface PermissionDecision {
    decision: 'allow' | 'reject' | 'cancel'
    optionId: string | null
    source: 'policy' | 'callback' | 'fallback' | 'aborted'
    elapsedMs: number
    error?: string
}

function chooseOption(options: PermissionOption[], decision: 'allow' | 'reject'): string | null {
    const preferred =
        decision === 'allow'
            ? ['allow_once', 'allow_always', 'allow']
            : ['reject_once', 'reject_always', 'reject']
    for (const kind of preferred) {
        const found = options.find((option) => (option.kind ?? '').toLowerCase() === kind)
        if (found !== undefined) return found.optionId
    }
    return options[0]?.optionId ?? null
}

/** Resolve one `session/request_permission` according to the configured policy. */
export class PermissionBroker {
    constructor(private readonly config: PermissionConfig) {}

    async decide(
        request: PermissionRequest,
        signal?: AbortSignal,
    ): Promise<PermissionDecision> {
        const started = Date.now()
        const finish = (
            decision: 'allow' | 'reject' | 'cancel',
            source: PermissionDecision['source'],
            error?: string,
        ): PermissionDecision => ({
            decision,
            optionId:
                decision === 'cancel' ? null : chooseOption(request.options, decision),
            source,
            elapsedMs: Date.now() - started,
            ...(error === undefined ? {} : { error }),
        })

        if (signal?.aborted === true) return finish('cancel', 'aborted')
        if (this.config.mode === 'allow') return finish('allow', 'policy')
        if (this.config.mode === 'reject') return finish('reject', 'policy')
        if (this.config.mode === 'cancel') return finish('cancel', 'policy')

        if (this.config.callbackUrl === null) {
            return finish(this.config.fallback, 'fallback', 'no approval callback configured')
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
        const onAbort = () => controller.abort()
        signal?.addEventListener('abort', onAbort, { once: true })
        try {
            const response = await fetch(this.config.callbackUrl, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...this.config.headers,
                },
                body: JSON.stringify({
                    requestId: request.requestId,
                    sessionId: request.sessionId,
                    toolCall: request.toolCall,
                    options: request.options,
                }),
                signal: controller.signal,
            })
            if (!response.ok) {
                throw new Error(`approval callback HTTP ${response.status}`)
            }
            const body = (await response.json()) as {
                decision?: unknown
                optionId?: unknown
                outcome?: { optionId?: unknown }
            }
            const raw = body.decision ?? body.outcome?.optionId ?? body.optionId
            const decision =
                raw === 'allow' || raw === 'reject' || raw === 'cancel'
                    ? raw
                    : this.config.fallback
            const optionId =
                typeof body.optionId === 'string'
                    ? body.optionId
                    : typeof body.outcome?.optionId === 'string'
                      ? body.outcome.optionId
                      : decision === 'cancel'
                        ? null
                        : chooseOption(request.options, decision)
            return {
                decision,
                optionId,
                source: 'callback',
                elapsedMs: Date.now() - started,
            }
        } catch (error) {
            return finish(
                this.config.fallback,
                'fallback',
                error instanceof Error ? error.message : String(error),
            )
        } finally {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
        }
    }
}

/** JSON-RPC result expected by ACP for `session/request_permission`. */
export function permissionOutcome(decision: PermissionDecision): unknown {
    if (decision.decision === 'cancel' || decision.optionId === null) {
        return { outcome: { outcome: 'cancelled' } }
    }
    return { outcome: { outcome: 'selected', optionId: decision.optionId } }
}

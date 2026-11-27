/** Execution contract used by the platform transports. One active turn per session. */
export interface HarnessRequest {
    sessionId: string
    prompt: string
    stream?: boolean
    eventId?: string
    attempt?: number
    options?: Record<string, unknown>
}

export interface HarnessEvent {
    type: string
    [field: string]: unknown
}

export interface HarnessResult {
    ok: boolean
    output: string
    sessionId: string
    stopReason: string
    error: { code: string; message: string; statusCode?: number } | null
}

export interface HarnessTurn {
    events: AsyncIterable<HarnessEvent>
    result: Promise<HarnessResult>
    cancel(): void
}

export interface HarnessRunner {
    runTurn(request: HarnessRequest, signal?: AbortSignal): Promise<HarnessTurn>
    start(): Promise<void>
    readonly ready: boolean
    dispose(): Promise<void>
}

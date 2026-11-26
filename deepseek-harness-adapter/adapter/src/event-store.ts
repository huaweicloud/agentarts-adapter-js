import { randomUUID } from 'node:crypto'
import { type ProtocolStorage, protocolFingerprint } from '@huaweicloud/agentarts-sdk/sdk/runtime'
import type { HarnessRunner, HarnessRequest, HarnessResult, HarnessTurn } from './runner.js'

interface RecordValue { owner: string; fingerprint: string; attempt: number; result?: HarnessResult }

/** One managed process owns a storage directory. An interrupted claim requires reconciliation. */
export class EventStoreRunner implements HarnessRunner {
    constructor(private readonly inner: HarnessRunner, private readonly storage: ProtocolStorage) {}
    start() { return this.inner.start() }
    get ready() { return this.inner.ready }
    dispose() { return this.inner.dispose() }

    async runTurn(request: HarnessRequest, signal?: AbortSignal): Promise<HarnessTurn> {
        if (!request.eventId) return this.inner.runTurn(request, signal)
        const owner = randomUUID()
        const scope = protocolFingerprint(['invocations', request.sessionId])
        const key = protocolFingerprint(request.eventId)
        const options = { ...request.options }
        for (const name of ['eventId', 'attempt', 'sessionId', 'prompt', 'message', 'input', 'action', 'stream']) delete options[name]
        const fingerprint = protocolFingerprint([request.prompt, options])
        const attempt = request.attempt ?? 1
        const claimed = await this.storage.update<RecordValue>(scope, key, previous => {
            if (!previous || (previous.fingerprint === fingerprint && attempt > previous.attempt && retryable(previous.result))) {
                return { owner, fingerprint, attempt }
            }
            return previous
        })
        if (!claimed) throw new Error('Missing event claim')
        if (claimed.owner !== owner) {
            if (claimed.fingerprint !== fingerprint) throw conflict('event_conflict', 'eventId was already used with different input')
            if (!claimed.result) throw conflict('event_pending', 'Event is running or awaits reconciliation')
            return { events: (async function* () {})(), result: Promise.resolve(claimed.result), cancel() {} }
        }
        let turn: HarnessTurn
        try {
            turn = await this.inner.runTurn(request, signal)
        } catch (error) {
            // runTurn rejects before handing off execution. No prompt was admitted.
            await this.storage.update<RecordValue>(scope, key, previous => previous?.owner === owner ? undefined : previous)
            throw error
        }
        const result = turn.result.catch((error: unknown): HarnessResult => ({
            ok: false,
            output: '',
            sessionId: request.sessionId,
            stopReason: 'error',
            error: { code: 'runner_failed', statusCode: 502, message: error instanceof Error ? error.message : String(error) },
        })).then(async outcome => {
            const snapshot = JSON.parse(JSON.stringify(outcome)) as HarnessResult
            await this.storage.update<RecordValue>(scope, key, previous => {
                if (previous?.owner !== owner) throw new Error('Event claim ownership changed')
                return { ...previous, result: snapshot }
            })
            return outcome
        })
        // Consumers may still be draining events when a storage write fails.
        void result.catch(() => {})
        return { ...turn, result }
    }
}

function retryable(result: HarnessResult | undefined): boolean {
    if (!result || result.ok) return false
    const status = result.error?.statusCode
    return status === 502 || status === 503 || status === 504
}

function conflict(code: string, message: string) {
    return Object.assign(new Error(message), { code, statusCode: 409 })
}

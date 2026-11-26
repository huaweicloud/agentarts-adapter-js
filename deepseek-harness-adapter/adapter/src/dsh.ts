import { AcpRuntime, normalizePayload, project, RuntimeError, toRuntimeError, type RuntimeConfig } from '@agentarts/harness-dsh-runtime'
import type { HarnessRequest, HarnessRunner } from './runner.js'

export class DshRunner implements HarnessRunner {
    readonly runtime: AcpRuntime

    constructor(config: RuntimeConfig) {
        this.runtime = new AcpRuntime(config)
    }

    start() { return this.runtime.start() }
    get ready() { return this.runtime.ready }
    dispose() { return this.runtime.dispose() }

    async runTurn(request: HarnessRequest, signal?: AbortSignal) {
        let input
        try {
            input = normalizePayload({ ...request.options, ...request })
        } catch (cause) {
            throw new RuntimeError(cause instanceof Error ? cause.message : 'Invalid turn request',
                { code: 'invalid_request', statusCode: 400, cause })
        }
        const turn = await this.runtime.runTurn(input, signal).catch(error => { throw toRuntimeError(error) })
        return {
            ...turn,
            events: (async function* () {
                for await (const event of turn.events) {
                    if (event.type !== 'error' && event.type !== 'run_finished') yield project(event)
                }
            })(),
        }
    }
}

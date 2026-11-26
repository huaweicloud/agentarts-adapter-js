import type { HarnessRequest, HarnessEvent, HarnessRunner } from '../runner.js'
import type { Frame } from '@agentarts/harness-dsh-shared'
import type { RoundOutcome } from '../scheduler/run.js'

export function wsRounds(runner: HarnessRunner) {
    return {
        async run(request: HarnessRequest, signal?: AbortSignal) {
            const turn = await runner.runTurn({ ...request, stream: true }, signal)
            async function* frames(): AsyncGenerator<Frame> {
                let revision = 0
                for await (const e of turn.events) {
                    const frame = toFrame(e, request.sessionId, ++revision)
                    if (frame) yield frame
                }
            }
            const outcome = turn.result.then((result): RoundOutcome => ({
                ok: result.ok, exitCode: null, error: result.error?.message ?? null,
                final: result.ok ? { type: 'final', sessionId: request.sessionId, text: result.output,
                    reason: { kind: result.stopReason === 'end_turn' ? 'completed' : result.stopReason } } : null,
            }))
            return { frames: frames(), outcome, cancel: turn.cancel }
        },
    }
}

function toFrame(e: HarnessEvent, sessionId: string, revision: number): Frame | undefined {
    switch (e.type) {
        case 'session_ready': return { type: 'session', sessionId, cwd: String(e.cwd ?? '') }
        case 'run_started': return { type: 'status', phase: 'turn_start' }
        case 'text_delta': return { type: 'delta', kind: e.channel === 'message' ? 'text' : String(e.channel), text: String(e.delta),
            attemptId: String(e.attemptId ?? e.messageId), revision: typeof e.revision === 'number' ? e.revision : revision }
        case 'tool_call': return { type: 'tool_call', callId: String(e.toolCallId), tool: String(e.name ?? e.title), input: e.rawInput }
        case 'tool_call_update':
            if (e.status === 'completed' || e.status === 'failed') return { type: 'tool_result', callId: String(e.toolCallId), status: e.status, result: e.rawOutput ?? e.content }
    }
}

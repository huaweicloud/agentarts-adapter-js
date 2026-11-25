import type {
    Frame, RoundRequest, RoundHandle, RoundOutcome, SchedulerLike,
} from '@agentarts/harness-dsh-shared'

import { AsyncQueue } from './async-queue.js'
import { AcpRuntime } from './runtime.js'
import type { RuntimeEvent, TurnRequest } from './types.js'

/**
 * Adapter-compatible scheduler backed by one persistent ACP runtime.
 *
 * Upper protocol handlers (invocations/WS/A2A/AG-UI) only know the frame
 * contract, so the ACP event stream is projected into that vocabulary here.
 */
export class AcpScheduler implements SchedulerLike {
    constructor(
        private readonly runtime: AcpRuntime,
        private readonly mapRequest: (request: RoundRequest) => TurnRequest = (request) => ({
            sessionId: request.sessionId,
            prompt: request.prompt,
        }),
    ) {}

    async run(request: RoundRequest, signal?: AbortSignal): Promise<RoundHandle> {
        let turn
        try {
            turn = await this.runtime.runTurn(this.mapRequest(request), signal)
        } catch (error) {
            // 与 spawn 后端一致：执行层失败通过 outcome 结算，不向协议层抛错
            return failedHandle(error)
        }
        const frames = new AsyncQueue<Frame>()
        let final: Frame | null = null

        const outcome = (async (): Promise<RoundOutcome> => {
            try {
                let revision = 0
                for await (const event of turn.events) {
                    const mapped = project(event, () => ++revision)
                    if (mapped !== null) frames.push(mapped)
                }
                const result = await turn.result
                if (result.ok) {
                    final = {
                        type: 'final',
                        text: result.output,
                        reason: { kind: result.stopReason },
                        sessionId: result.sessionId,
                    }
                }
                frames.end()
                return {
                    ok: result.ok,
                    final: final as RoundOutcome['final'],
                    error: result.error?.message ?? null,
                    exitCode: null,
                }
            } catch (error) {
                frames.end()
                return {
                    ok: false,
                    final: null,
                    error: error instanceof Error ? error.message : String(error),
                    exitCode: null,
                }
            }
        })()

        return {
            frames,
            outcome,
            cancel: () => turn.cancel(),
        }
    }
}

function failedHandle(error: unknown): RoundHandle {
    return {
        frames: (async function* () {})(),
        outcome: Promise.resolve({
            ok: false,
            final: null,
            error: error instanceof Error ? error.message : String(error),
            exitCode: null,
        }),
        cancel: () => {},
    }
}

function project(event: RuntimeEvent, nextRevision: () => number): Frame | null {
    switch (event.type) {
        case 'session':
            return { type: 'session', sessionId: event.sessionId, cwd: event.cwd }
        case 'text_delta':
            return {
                type: 'delta',
                kind: event.channel,
                text: event.delta,
                attemptId: event.messageId,
                revision: nextRevision(),
            }
        case 'tool_call':
            return {
                type: 'tool_call',
                callId: String(event.toolCallId ?? ''),
                tool: String(event.name ?? event.title ?? 'tool'),
                input: event.rawInput ?? {},
            }
        case 'tool_call_update':
            if (event.status === 'completed' || event.status === 'failed') {
                return {
                    type: 'tool_result',
                    callId: String(event.toolCallId ?? ''),
                    status: String(event.status),
                    result: event.rawOutput ?? event.content ?? null,
                }
            }
            return null
        case 'permission_request':
            return {
                type: 'question',
                callId: event.requestId,
                questions: [
                    {
                        toolCall: event.toolCall,
                        options: event.options,
                    },
                ],
                timeoutSec: Math.max(
                    1,
                    Math.floor((event.expiresAt - Date.now()) / 1000),
                ),
            }
        case 'run_finished':
            return null
        case 'error':
            return null
        default:
            return null
    }
}

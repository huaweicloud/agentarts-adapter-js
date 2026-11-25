import type { RoundRequest } from '@agentarts/harness-dsh-shared'
import type { RoundHandle } from './run.js'

/**
 * Structural scheduler contract consumed by the upper protocol handlers.
 *
 * `Scheduler` (spawn-per-round) and the ACP runtime scheduler both implement
 * this interface, so `/invocations`, WebSocket, A2A and AG-UI stay unchanged.
 */
export interface SchedulerLike {
    run(req: RoundRequest, signal?: AbortSignal): Promise<RoundHandle>
}

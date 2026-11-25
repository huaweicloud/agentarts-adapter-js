/**
 * Structural scheduler contract consumed by the upper protocol handlers.
 *
 * `Scheduler` (spawn-per-round) and the ACP runtime scheduler both implement
 * this interface, so `/invocations`, WebSocket, A2A and AG-UI stay unchanged.
 */
export type { SchedulerLike } from '@agentarts/harness-dsh-shared'

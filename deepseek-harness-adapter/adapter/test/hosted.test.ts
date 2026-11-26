import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startHostedHarness } from '../src/app.js'
import type { HarnessRunner } from '../src/runner.js'

it('hosts a non-DSH runner and shuts it down once with an idle websocket', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hosted-runner-'))
    vi.stubEnv('AGENTARTS_EVENT_STORAGE_DIR', dir)
    for (const name of ['AGENTARTS_PROTOCOL_TOKEN', 'A2A_PORT', 'AGENTARTS_PROTOCOL_PUBLIC_ORIGIN', 'AGENTARTS_PROTOCOL_STORAGE_DIR']) {
        vi.stubEnv(name, '')
    }
    const dispose = vi.fn(async () => {})
    const runner: HarnessRunner = { ready: true, async start() {}, dispose,
        async runTurn(request) {
            return { events: (async function* () {})(), cancel() {},
                result: Promise.resolve({ ok: true, sessionId: request.sessionId, output: request.prompt, stopReason: 'end_turn', error: null }) }
        },
    }
    const service = startHostedHarness(runner, { host: '127.0.0.1', port: 0, maxConcurrency: 1 })
    try {
        await once(service.main, 'listening')
        const port = (service.main.address() as { port: number }).port
        const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws')
        await once(ws, 'open')
        const response = await fetch('http://127.0.0.1:' + port + '/invocations', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'from another harness', stream: false }),
        })
        expect((await response.json()).output).toBe('from another harness')
        await Promise.all([service.stop(), service.stop()])
        expect(dispose).toHaveBeenCalledTimes(1)
    } finally {
        await service.stop()
        vi.unstubAllEnvs()
        await rm(dir, { recursive: true, force: true })
    }
})

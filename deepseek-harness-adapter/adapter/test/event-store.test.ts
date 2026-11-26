import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileProtocolStorage } from '@huaweicloud/agentarts-sdk/sdk/runtime'
import { EventStoreRunner } from '../src/event-store.js'
import type { HarnessRunner, HarnessResult } from '../src/runner.js'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

it('claims concurrent retries once and restores the result from disk after reopening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentarts-event-'))
    dirs.push(dir)
    let calls = 0
    let finish!: (value: HarnessResult) => void
    const inner: HarnessRunner = {
        ready: true, async start() {}, async dispose() {},
        async runTurn() {
            calls++
            return { events: (async function* () {})(), result: new Promise<HarnessResult>(resolve => { finish = resolve }), cancel() {} }
        },
    }
    const first = new EventStoreRunner(inner, new FileProtocolStorage(dir))
    const request = { sessionId: 's', eventId: 'e', prompt: 'hello' }
    const handle = await first.runTurn(request)
    await expect(first.runTurn({ ...request, attempt: 2 })).rejects.toMatchObject({ code: 'event_pending' })
    finish({ ok: true, sessionId: 's', output: 'saved', stopReason: 'end_turn', error: null })
    await handle.result
    const reopened = new EventStoreRunner(inner, new FileProtocolStorage(dir))
    const replay = await reopened.runTurn({ ...request, stream: false, attempt: 3 })
    expect((await replay.result).output).toBe('saved')
    await expect(reopened.runTurn({ ...request, prompt: 'different' })).rejects.toMatchObject({ code: 'event_conflict' })
    expect(calls).toBe(1)
})

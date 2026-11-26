import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GatewayResolver } from '../src/gateway.js'
import { AcpRuntime } from '../src/runtime.js'
import { loadConfig } from '../src/config.js'
import type { RuntimeConfig, RuntimeEvent } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))
const dirs: string[] = []

function config(): RuntimeConfig {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'acp-workspace-'))
    dirs.push(workspace)
    return loadConfig({
        DSH_ACP_COMMAND: process.execPath,
        DSH_ACP_ARGS: fixture,
        DSH_AGENT_CWD: workspace,
        DSH_ACP_PERMISSION_MODE: 'allow',
        DSH_ACP_PROMPT_TIMEOUT_MS: '5000',
    })
}

afterEach(() => {
    for (const directory of dirs.splice(0)) {
        rmSync(directory, { recursive: true, force: true })
    }
})

describe('ACP runtime', () => {
    it('streams token events and uses the committed text as final output', async () => {
        const runtime = new AcpRuntime(config())
        const handle = await runtime.runTurn({ sessionId: 's1', prompt: 'hi' })
        const events: RuntimeEvent[] = []
        for await (const event of handle.events) events.push(event)
        const result = await handle.result
        expect(result.ok).toBe(true)
        expect(result.output).toBe('Hello')
        expect(events.some((event) => event.type === 'session')).toBe(true)
        expect(
            events.filter((event) => event.type === 'text_delta' && event.token).length,
        ).toBe(2)
        expect(events.some((event) => event.type === 'tool_call')).toBe(true)
        await runtime.dispose()
    })

    it('reuses one ACP session across turns', async () => {
        const runtime = new AcpRuntime(config())
        const first = await runtime.runTurn({ sessionId: 'reuse', prompt: 'one' })
        for await (const _event of first.events) void _event
        await first.result
        const second = await runtime.runTurn({ sessionId: 'reuse', prompt: 'two' })
        let reused = false
        for await (const event of second.events) {
            if (event.type === 'session' && event.reused) reused = true
        }
        await second.result
        expect(reused).toBe(true)
        await runtime.dispose()
    })
})

it.each(['before', 'during'])('preserves FIFO when a waiter aborts %s admission', async (when) => {
    const runtime = new AcpRuntime(config())
    try {
        const first = await runtime.runTurn({ sessionId: 'same', prompt: 'hang' })
        const controller = new AbortController()
        if (when === 'before') controller.abort()
        const skipped = runtime.runTurn({ sessionId: 'same', prompt: 'skip' }, controller.signal)
        controller.abort()
        const rejected = expect(skipped).rejects.toMatchObject({ code: 'cancelled' })
        let started = false
        const next = runtime.runTurn({ sessionId: 'same', prompt: 'next' }).then(handle => {
            started = true
            return handle
        })
        await new Promise(resolve => setTimeout(resolve, 30))
        expect(started).toBe(false)
        first.cancel()
        expect(await first.result).toMatchObject({ ok: false, stopReason: 'cancelled' })
        await rejected
        expect(await (await next).result).toMatchObject({ ok: true })
    } finally {
        await runtime.dispose()
    }
})

it('removes timed-out waiters and cancels an active prompt via its signal', async () => {
    const runtime = new AcpRuntime({ ...config(), queueTimeoutMs: 50 })
    const controller = new AbortController()
    try {
        const active = await runtime.runTurn({ sessionId: 'q', prompt: 'hang' }, controller.signal)
        await expect(runtime.runTurn({ sessionId: 'q', prompt: 'skip' })).rejects.toMatchObject({ code: 'queue_timeout' })
        controller.abort()
        expect(await active.result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
        const next = await runtime.runTurn({ sessionId: 'q', prompt: 'normal' })
        expect((await next.result).ok).toBe(true)
    } finally { await runtime.dispose() }
})

it('releases a nonresponsive prompt only after retiring its ACP session', async () => {
    const runtime = new AcpRuntime({ ...config(), promptTimeoutMs: 40 })
    try {
        const first = await runtime.runTurn({ sessionId: 'stuck', prompt: 'ignore-cancel' })
        expect(await first.result).toMatchObject({ ok: false, error: { code: 'prompt_timeout' } })
        const next = await runtime.runTurn({ sessionId: 'stuck', prompt: 'normal', timeoutMs: 2000 })
        const result = await next.result
        expect(result.ok).toBe(true)
        expect(result.acpSessionId).not.toBe((await first.result).acpSessionId)
    } finally { await runtime.dispose() }
}, 15000)

it('bounds undrained streams while result-only requests allocate no event backlog', async () => {
    const runtime = new AcpRuntime(config())
    try {
        const streaming = await runtime.runTurn({ sessionId: 'bounded', prompt: 'flood' })
        expect(await streaming.result).toMatchObject({ ok: false, error: { code: 'output_limit' } })
        const json = await runtime.runTurn({ sessionId: 'bounded', prompt: 'flood', stream: false })
        expect((await json.result).ok).toBe(true)
        const events = []
        for await (const event of json.events) events.push(event)
        expect(events).toHaveLength(0)
    } finally { await runtime.dispose() }
})

it('releases a cancelled caller during gateway discovery before opening an ACP session', async () => {
    const runtime = new AcpRuntime(config())
    let discoveryStarted!: () => void
    const started = new Promise<void>(resolve => { discoveryStarted = resolve })
    let finish!: () => void
    const discovery = vi.spyOn(GatewayResolver.prototype, 'resolve').mockImplementationOnce(() => {
        discoveryStarted()
        return new Promise(resolve => { finish = () => resolve(null) })
    })
    const controller = new AbortController()
    try {
        const first = runtime.runTurn({ sessionId: 'setup', prompt: 'unused' }, controller.signal)
        await started
        controller.abort()
        await expect(first).rejects.toMatchObject({ code: 'cancelled' })
        expect(runtime.sessionsCount).toBe(0)
        expect((await (await runtime.runTurn({ sessionId: 'setup', prompt: 'next' })).result).ok).toBe(true)
    } finally {
        finish?.()
        discovery.mockRestore()
        await runtime.dispose()
    }
})

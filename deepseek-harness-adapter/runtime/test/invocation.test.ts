import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createInvocationHandler } from '../src/invocation-handler.js'
import { createRuntimeApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { AcpRuntime } from '../src/runtime.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))
const dirs: string[] = []

function makeRuntime(): AcpRuntime {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'acp-http-'))
    dirs.push(workspace)
    return new AcpRuntime(
        loadConfig({
            DSH_ACP_COMMAND: process.execPath,
            DSH_ACP_ARGS: fixture,
            DSH_AGENT_CWD: workspace,
            DSH_ACP_PERMISSION_MODE: 'allow',
        }),
    )
}

afterEach(() => {
    for (const directory of dirs.splice(0)) {
        rmSync(directory, { recursive: true, force: true })
    }
})

describe('runtime /invocations', () => {
    it('returns an SSE event iterable for stream:true', async () => {
        const runtime = makeRuntime()
        const handler = createInvocationHandler(runtime)
        const result = await handler({ prompt: 'hi', sessionId: 's-http' })
        expect(typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe('function')
        const events: Array<Record<string, unknown>> = []
        for await (const event of result as AsyncIterable<Record<string, unknown>>) {
            events.push(event)
        }
        expect(events.some((event) => event.type === 'session_ready')).toBe(true)
        expect(
            events.filter((event) => event.type === 'text_delta' && event.token === true)
                .length,
        ).toBe(2)
        expect(events.at(-1)?.type).toBe('run_finished')
        await runtime.dispose()
    })

    it('emits one error terminal for a failed ACP prompt', async () => {
        const runtime = makeRuntime()
        try {
            const handler = createInvocationHandler(runtime)
            const stream = await handler({ prompt: 'fail-prompt' })
            const events = await Array.fromAsync(stream as AsyncIterable<{ type: string }>)
            expect(events.filter(event => event.type === 'error' || event.type === 'run_finished'))
                .toEqual([expect.objectContaining({ type: 'error', code: 'acp_error', message: 'fixture prompt failed' })])
        } finally {
            await runtime.dispose()
        }
    })

    it('continues after malformed stdout and logs once without logging the raw line', async () => {
        const runtime = makeRuntime()
        const stderr = vi.spyOn(process.stderr, 'write')
        try {
            const handler = createInvocationHandler(runtime)
            const stream = await handler({ prompt: 'malformed-stdout' })
            const events = await Array.fromAsync(stream as AsyncIterable<{ type: string }>)
            expect(events.at(-1)).toMatchObject({ type: 'run_finished', output: 'Hello' })
            const logs = stderr.mock.calls.map(([line]) => String(line))
            expect(logs.filter(line => line.includes('malformed ACP stdout'))).toHaveLength(1)
            expect(logs.join('')).not.toContain('fixture-private-output')
        } finally {
            stderr.mockRestore()
            await runtime.dispose()
        }
    })

    it('returns one JSON response for stream:false', async () => {
        const runtime = makeRuntime()
        const handler = createInvocationHandler(runtime)
        const response = (await handler({
            prompt: 'hi',
            sessionId: 's-json',
            stream: false,
        })) as { statusCode?: number; body?: string | Buffer | null }
        expect(response.statusCode).toBe(200)
        const body = JSON.parse(String(response.body)) as Record<string, unknown>
        expect(body.output).toBe('Hello')
        await runtime.dispose()
    })

    it('handles list, close and set_config management actions', async () => {
        const runtime = makeRuntime()
        const handler = createInvocationHandler(runtime)
        const first = await handler({ prompt: 'hi', sessionId: 'manage', stream: false })
        expect((first as { statusCode?: number }).statusCode).toBe(200)

        const list = (await handler({ action: 'list', cwd: process.cwd() })) as {
            statusCode?: number
            body?: string | Buffer | null
        }
        expect(list.statusCode).toBe(200)
        expect(JSON.parse(String(list.body)).sessions.length).toBeGreaterThan(0)

        const config = (await handler({
            action: 'set_config',
            sessionId: 'manage',
            model: 'fake',
        })) as { statusCode?: number; body?: string | Buffer | null }
        expect(config.statusCode).toBe(200)
        expect(JSON.parse(String(config.body)).applied).toContain('model')

        const closed = (await handler({ action: 'close', sessionId: 'manage' })) as {
            statusCode?: number
            body?: string | Buffer | null
        }
        expect(closed.statusCode).toBe(200)
        expect(JSON.parse(String(closed.body)).closed).toBe(true)
        await runtime.dispose()
    })

    it('非法 timeoutMs 直接 400，不进队列', async () => {
        const runtime = makeRuntime()
        const handler = createInvocationHandler(runtime)
        for (const timeoutMs of ['abc', 0, -5, Number.NaN]) {
            const response = (await handler({
                prompt: 'hi',
                sessionId: 'bad-timeout',
                timeoutMs,
            })) as { statusCode?: number; body?: string | Buffer | null }
            expect(response.statusCode).toBe(400)
            const body = JSON.parse(String(response.body)) as { error?: { code?: string } }
            expect(body.error?.code).toBe('invalid_request')
        }
        await runtime.dispose()
    })

    it('管理动作保留 RuntimeError 状态码（session 不存在 → 404）', async () => {
        const runtime = makeRuntime()
        const handler = createInvocationHandler(runtime)
        const response = (await handler({
            action: 'set_config',
            sessionId: 'missing',
            model: 'm',
        })) as { statusCode?: number; body?: string | Buffer | null }
        expect(response.statusCode).toBe(404)
        await runtime.dispose()
    })

    it('dispose 后调用返回 503', async () => {
        const runtime = makeRuntime()
        await runtime.dispose()
        const handler = createInvocationHandler(runtime)
        const response = (await handler({ prompt: 'hi', sessionId: 'late' })) as {
            statusCode?: number
            body?: string | Buffer | null
        }
        expect(response.statusCode).toBe(503)
    })

    it('serves SSE through the composed AgentArts app', async () => {
        const runtime = makeRuntime()
        const app = createRuntimeApp(runtime)
        const server = app.run('127.0.0.1', 0)
        await new Promise<void>((resolve) => server.once('listening', () => resolve()))
        const address = server.address()
        const port =
            typeof address === 'object' && address !== null ? address.port : 0
        try {
            const response = await fetch(`http://127.0.0.1:${port}/invocations`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ prompt: 'hi', sessionId: 'sse-app' }),
            })
            expect(response.status).toBe(200)
            const body = await response.text()
            expect(body).toContain('"type":"session_ready"')
            expect(body).toContain('"type":"text_delta"')
            expect(body).toContain('"type":"run_finished"')
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()))
            await runtime.dispose()
        }
    })
})

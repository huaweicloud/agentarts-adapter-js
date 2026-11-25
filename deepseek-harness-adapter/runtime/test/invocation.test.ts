import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

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

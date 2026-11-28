import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AcpClient } from '../src/acp-client.js'
import { AcpRuntime } from '../src/runtime.js'
import { loadConfig } from '../src/config.js'
import type { RuntimeConfig } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))
const dirs: string[] = []

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'acp-manage-'))
    dirs.push(workspace)
    return {
        ...loadConfig({
            DSH_ACP_COMMAND: process.execPath,
            DSH_ACP_ARGS: fixture,
            DSH_AGENT_CWD: workspace,
            DSH_ACP_PERMISSION_MODE: 'allow',
        }),
        ...overrides,
    }
}

function workspace(): string {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'acp-other-'))
    dirs.push(directory)
    return directory
}

afterEach(() => {
    for (const directory of dirs.splice(0)) {
        rmSync(directory, { recursive: true, force: true })
    }
})

describe('ACP runtime management actions', () => {
    it('lists resumable sessions through the ACP client', async () => {
        const runtime = new AcpRuntime(config())
        try {
            const turn = await runtime.runTurn({ sessionId: 'listed', prompt: 'hi', stream: false })
            await turn.result
            const listed = await runtime.listSessions()
            expect(listed.sessions).toHaveLength(1)
            expect(listed.sessions[0]).toMatchObject({
                sessionId: expect.any(String),
                cwd: expect.any(String),
            })
        } finally {
            await runtime.dispose()
        }
    })

    it('closes a session once and reports unknown keys', async () => {
        const runtime = new AcpRuntime(config())
        try {
            const turn = await runtime.runTurn({ sessionId: 'closing', prompt: 'hi', stream: false })
            await turn.result
            expect(await runtime.closeSession('closing')).toBe(true)
            expect(await runtime.closeSession('closing')).toBe(false)
            expect(runtime.sessionsCount).toBe(0)
        } finally {
            await runtime.dispose()
        }
    })

    it('applies model, reasoning and arbitrary config options', async () => {
        const runtime = new AcpRuntime(config())
        try {
            const turn = await runtime.runTurn({ sessionId: 'configured', prompt: 'hi', stream: false })
            await turn.result
            const applied = await runtime.setConfig('configured', {
                model: 'deepseek-chat',
                reasoningEffort: 'high',
                configOptions: [{ configId: 'temperature', value: '0.2' }],
            })
            expect(applied).toEqual({
                sessionId: 'configured',
                applied: ['model', 'reasoning_effort', 'temperature'],
            })
            await expect(
                runtime.setConfig('missing', { model: 'deepseek-chat' }),
            ).rejects.toMatchObject({ code: 'session_not_found', statusCode: 404 })
        } finally {
            await runtime.dispose()
        }
    })

    it('cancels only an in-flight turn', async () => {
        const runtime = new AcpRuntime(config())
        try {
            expect(runtime.cancelSession('idle')).toBe(false)
            const turn = await runtime.runTurn({ sessionId: 'cancel-me', prompt: 'hang' })
            expect(runtime.cancelSession('cancel-me')).toBe(true)
            expect(await turn.result).toMatchObject({ ok: false, stopReason: 'cancelled' })
        } finally {
            await runtime.dispose()
        }
    })

    it('rejects a different cwd for an existing session', async () => {
        const runtime = new AcpRuntime(config())
        try {
            const turn = await runtime.runTurn({ sessionId: 'pinned', prompt: 'hi', stream: false })
            await turn.result
            await expect(
                runtime.runTurn({ sessionId: 'pinned', prompt: 'hi', cwd: workspace() }),
            ).rejects.toMatchObject({ code: 'session_cwd_mismatch', statusCode: 409 })
        } finally {
            await runtime.dispose()
        }
    })

    it('refuses new turns after dispose and disposes idempotently', async () => {
        const runtime = new AcpRuntime(config())
        await runtime.dispose()
        await runtime.dispose()
        await expect(
            runtime.runTurn({ sessionId: 'late', prompt: 'hi' }),
        ).rejects.toMatchObject({ code: 'shutting_down', statusCode: 503 })
    })
})

describe('session resume', () => {
    it('reattaches the requested persisted session without creating a new one', async () => {
        const runtime = new AcpRuntime(config())
        const created = vi.spyOn(AcpClient.prototype, 'newSession')
        try {
            const turn = await runtime.runTurn({
                sessionId: 'app-resume',
                acpSessionId: 'resumed-1',
                prompt: 'hi',
            })
            const events: Array<Record<string, unknown>> = []
            for await (const event of turn.events) events.push(event as Record<string, unknown>)
            const result = await turn.result

            expect(result).toMatchObject({ ok: true, acpSessionId: 'resumed-1' })
            expect(events.find((event) => event.type === 'session')).toMatchObject({
                acpSessionId: 'resumed-1',
                sessionId: 'app-resume',
            })
            // Text deltas only route when byAcp was keyed by the resumed id.
            expect(events.some((event) => event.type === 'text_delta')).toBe(true)
            expect(created).not.toHaveBeenCalled()
            expect(runtime.sessionsCount).toBe(1)
        } finally {
            created.mockRestore()
            await runtime.dispose()
        }
    })

    it('maps the DSH resume failures onto the runtime error contract', async () => {
        const runtime = new AcpRuntime(config())
        try {
            await expect(
                runtime.runTurn({ sessionId: 'a', acpSessionId: 'wrong-cwd-1', prompt: 'hi' }),
            ).rejects.toMatchObject({ code: 'session_cwd_mismatch', statusCode: 409 })
            await expect(
                runtime.runTurn({ sessionId: 'b', acpSessionId: 'missing-1', prompt: 'hi' }),
            ).rejects.toMatchObject({ code: 'session_not_found', statusCode: 404 })
            await expect(
                runtime.runTurn({ sessionId: 'c', acpSessionId: 'busy-1', prompt: 'hi' }),
            ).rejects.toMatchObject({ code: 'session_conflict', statusCode: 409 })
            expect(runtime.sessionsCount).toBe(0)
        } finally {
            await runtime.dispose()
        }
    })

    it('reports a new ACP session without an id as an upstream error', async () => {
        const runtime = new AcpRuntime(config())
        const created = vi
            .spyOn(AcpClient.prototype, 'newSession')
            .mockResolvedValue({ sessionId: '', configOptions: [] })
        try {
            await expect(
                runtime.runTurn({ sessionId: 'no-id', prompt: 'hi' }),
            ).rejects.toMatchObject({ code: 'acp_error', statusCode: 502 })
            expect(runtime.sessionsCount).toBe(0)
        } finally {
            created.mockRestore()
            await runtime.dispose()
        }
    })
})

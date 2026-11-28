import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonResponse, StreamingResponse } from '@huaweicloud/agentarts-sdk/sdk/runtime'

import { DshRunner } from '../src/dsh.js'
import { decodeRequest, harnessInvocation } from '../src/handlers/harness-http.js'
import { wsRounds } from '../src/handlers/harness-ws.js'
import type { HarnessEvent, HarnessResult, HarnessRunner, HarnessTurn } from '../src/runner.js'
import { SESSION_HEADER } from '../src/types.js'
import { loadConfig } from '@agentarts/harness-dsh-runtime'

function result(overrides: Partial<HarnessResult> = {}): HarnessResult {
    return { ok: true, output: 'hi', sessionId: 's', stopReason: 'end_turn', error: null, ...overrides }
}

function turn(events: HarnessEvent[], outcome: HarnessResult, cancel = () => undefined): HarnessTurn {
    return {
        events: (async function* () {
            yield* events
        })(),
        result: Promise.resolve(outcome),
        cancel,
    }
}

function runner(turnHandle: HarnessTurn): HarnessRunner & { calls: number } {
    const fake = {
        calls: 0,
        async runTurn() {
            fake.calls += 1
            return turnHandle
        },
        async start() {},
        ready: true,
        async dispose() {},
    }
    return fake
}

describe('decodeRequest', () => {
    it('accepts prompt aliases and keeps explicit ids', () => {
        expect(
            decodeRequest({ input: 'hello', sessionId: 's-1', eventId: 'e-1', attempt: 3, stream: false }),
        ).toMatchObject({
            prompt: 'hello',
            sessionId: 's-1',
            eventId: 'e-1',
            attempt: 3,
            stream: false,
        })
        expect(decodeRequest({ message: 'hi' }).prompt).toBe('hi')
    })

    it('falls back to the request context or a fresh uuid', () => {
        expect(decodeRequest({ prompt: 'x' }).sessionId).toMatch(/^[0-9a-f-]{36}$/)
        expect(decodeRequest({ prompt: 'x' }, 'ctx-1').sessionId).toBe('ctx-1')
        expect(decodeRequest({ prompt: 'x', sessionId: '' }, 'ctx-1').sessionId).toBe('ctx-1')
        expect(decodeRequest({ prompt: 'x', attempt: 0 }).attempt).toBe(1)
        expect(decodeRequest({ prompt: 'x', eventId: '' }).eventId).toBeUndefined()
    })

    it('rejects a payload without a prompt', () => {
        expect(() => decodeRequest({ prompt: '' })).toThrowError(/prompt is required/)
        try {
            decodeRequest({})
        } catch (error) {
            expect(error).toMatchObject({ code: 'invalid_request', statusCode: 400 })
        }
    })
})

describe('harnessInvocation', () => {
    it('returns a JSON result with the session header', async () => {
        const response = (await harnessInvocation(runner(turn([], result({ output: 'answer' }))))({
            prompt: 'hi',
            sessionId: 's-1',
            stream: false,
        })) as JsonResponse
        expect(response.statusCode).toBe(200)
        expect(response.headers[SESSION_HEADER]).toBe('s-1')
        expect(JSON.parse(String(response.body))).toMatchObject({ output: 'answer', result: 'answer' })
    })

    it('maps a failed result to its status code', async () => {
        const response = (await harnessInvocation(
            runner(turn([], result({ ok: false, output: '', error: { code: 'session_not_found', message: 'gone', statusCode: 404 } }))),
        )({ prompt: 'hi', sessionId: 's', stream: false })) as JsonResponse
        expect(response.statusCode).toBe(404)
        expect(JSON.parse(String(response.body)).error).toMatchObject({ code: 'session_not_found' })
    })

    it('streams SSE frames and closes with run_finished', async () => {
        const cancel = vi.fn()
        const response = (await harnessInvocation(
            runner(turn([{ type: 'text_delta', delta: 'a' }], result({ output: 'a' }), cancel)),
        )({ prompt: 'hi', sessionId: 's' })) as StreamingResponse
        const chunks: string[] = []
        for await (const chunk of response.contentStream as AsyncIterable<string>) chunks.push(String(chunk))
        expect(chunks[0]).toBe('data: {"type":"text_delta","delta":"a"}\n\n')
        expect(chunks.at(-1)).toContain('"type":"run_finished"')
        expect(cancel).toHaveBeenCalled()
    })

    it('reports a broken stream as a round_failed frame', async () => {
        const cancel = vi.fn()
        const broken: HarnessTurn = {
            events: (async function* () {
                yield { type: 'text_delta', delta: 'a' }
                throw new Error('socket closed')
            })(),
            result: Promise.resolve(result()),
            cancel,
        }
        const response = (await harnessInvocation(runner(broken))({ prompt: 'hi', sessionId: 's' })) as StreamingResponse
        const chunks: string[] = []
        for await (const chunk of response.contentStream as AsyncIterable<string>) chunks.push(String(chunk))
        expect(chunks.at(-1)).toContain('"code":"round_failed"')
        expect(cancel).toHaveBeenCalled()
    })

    it('routes management actions and rejects unknown ones', async () => {
        const management = vi.fn(async () => new JsonResponse({ content: { sessions: [] } }))
        const handled = await harnessInvocation(runner(turn([], result())), management)({
            action: 'list',
            sessionId: 's',
        })
        expect(management).toHaveBeenCalledWith('list', expect.anything(), undefined)
        expect(handled.statusCode).toBe(200)

        const unsupported = (await harnessInvocation(runner(turn([], result())))({ action: 'nope' })) as JsonResponse
        expect(unsupported.statusCode).toBe(400)
        expect(JSON.parse(String(unsupported.body)).error.code).toBe('invalid_action')
    })

    it('surfaces runner failures with their status code', async () => {
        const failing = {
            ...runner(turn([], result())),
            async runTurn() {
                throw Object.assign(new Error('busy'), { code: 'CAPACITY' })
            },
        }
        const busy = (await harnessInvocation(failing)({ prompt: 'hi' })) as JsonResponse
        expect(busy.statusCode).toBe(503)

        const denied = {
            ...runner(turn([], result())),
            async runTurn() {
                throw Object.assign(new Error('nope'), { statusCode: 429, code: 'throttled' })
            },
        }
        expect(((await harnessInvocation(denied)({ prompt: 'hi' })) as JsonResponse).statusCode).toBe(429)
    })
})

describe('wsRounds', () => {
    const events: HarnessEvent[] = [
        { type: 'session_ready', cwd: '/w' },
        { type: 'run_started' },
        { type: 'text_delta', channel: 'message', delta: 'hi', messageId: 'm1' },
        { type: 'text_delta', channel: 'thought', delta: 'hm', attemptId: 'a1', revision: 4 },
        { type: 'tool_call', toolCallId: 'c1', name: 'echo', rawInput: { x: 1 } },
        { type: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { ok: true } },
        { type: 'tool_call_update', toolCallId: 'c1', status: 'pending' },
        { type: 'run_finished', stopReason: 'end_turn', output: 'done' },
    ]

    it('projects harness events into frames and a final outcome', async () => {
        const round = await wsRounds(runner(turn(events, result({ output: 'done' })))).run({
            sessionId: 'sess-1',
            prompt: 'hi',
        })
        const frames: Array<Record<string, unknown>> = []
        for await (const frame of round.frames) frames.push(frame as unknown as Record<string, unknown>)
        expect(frames.map((frame) => frame.type)).toEqual([
            'session',
            'status',
            'delta',
            'delta',
            'tool_call',
            'tool_result',
        ])
        expect(frames[2]).toMatchObject({ type: 'delta', kind: 'text', text: 'hi', attemptId: 'm1', revision: 3 })
        expect(frames[3]).toMatchObject({ type: 'delta', kind: 'thought', attemptId: 'a1', revision: 4 })
        expect(frames[4]).toMatchObject({ type: 'tool_call', callId: 'c1', tool: 'echo', input: { x: 1 } })
        expect(await round.outcome).toMatchObject({
            ok: true,
            final: { type: 'final', text: 'done', reason: { kind: 'completed' } },
        })
    })

    it('reports a failed turn as an outcome without a final frame', async () => {
        const failed = result({ ok: false, output: '', error: { code: 'x', message: 'boom' } })
        const round = await wsRounds(runner(turn([], failed))).run({ sessionId: 's', prompt: 'hi' })
        expect(await round.outcome).toMatchObject({ ok: false, final: null, error: 'boom' })
    })

    it('exposes the turn cancel function', async () => {
        const cancel = vi.fn()
        const round = await wsRounds(runner(turn([], result(), cancel))).run({ sessionId: 's', prompt: 'hi' })
        round.cancel()
        expect(cancel).toHaveBeenCalled()
    })
})

describe('DshRunner', () => {
    const directories: string[] = []

    afterEach(() => {
        for (const directory of directories.splice(0)) {
            rmSync(directory, { recursive: true, force: true })
        }
    })

    function config() {
        const workspace = mkdtempSync(path.join(os.tmpdir(), 'adapter-dsh-'))
        directories.push(workspace)
        return loadConfig({
            DSH_ACP_COMMAND: process.execPath,
            DSH_ACP_ARGS: 'unused.mjs',
            DSH_AGENT_CWD: workspace,
            DSH_ACP_PERMISSION_MODE: 'allow',
        })
    }

    it('projects runtime events and rejects invalid payloads', async () => {
        const dsh = new DshRunner(config())
        const start = vi.spyOn(dsh.runtime, 'start').mockResolvedValue()
        const runTurn = vi.spyOn(dsh.runtime, 'runTurn').mockResolvedValue({
            events: (async function* () {
                yield { type: 'session', sessionId: 's', acpSessionId: 'a', cwd: '/w', reused: false, mcpServers: [] }
                yield { type: 'error', code: 'x', message: 'y' }
                yield { type: 'run_finished', stopReason: 'end_turn', output: 'ok', thought: '' }
            })(),
            result: Promise.resolve(result({ output: 'ok' })),
            cancel: () => undefined,
        } as never)
        try {
            await dsh.start()
            expect(start).toHaveBeenCalled()
            expect(dsh.ready).toBe(false)

            const projected: Array<Record<string, unknown>> = []
            for await (const event of (await dsh.runTurn({ sessionId: 's', prompt: 'hi' })).events) {
                projected.push(event as Record<string, unknown>)
            }
            expect(projected).toEqual([
                { type: 'session_ready', sessionId: 's', acpSessionId: 'a', cwd: '/w', reused: false, mcpServers: [] },
            ])

            await expect(dsh.runTurn({ sessionId: 's', prompt: '' })).rejects.toMatchObject({
                code: 'invalid_request',
                statusCode: 400,
            })
        } finally {
            runTurn.mockRestore()
            start.mockRestore()
            await dsh.dispose()
        }
    })
})

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { PermissionBroker, permissionOutcome } from '../src/permission.js'
import type { PermissionConfig } from '../src/types.js'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})

describe('permission broker', () => {
    it('selects the allow option in allow mode', async () => {
        const broker = new PermissionBroker({
            mode: 'allow',
            callbackUrl: null,
            headers: {},
            timeoutMs: 1000,
            fallback: 'cancel',
        })
        const decision = await broker.decide({
            requestId: 'p1',
            sessionId: 's1',
            toolCall: {},
            options: [
                { optionId: 'no', kind: 'reject_once' },
                { optionId: 'yes', kind: 'allow_once' },
            ],
        })
        expect(decision.decision).toBe('allow')
        expect(decision.optionId).toBe('yes')
        expect(decision.source).toBe('policy')
    })

    it('uses an HTTP approval callback', async () => {
        const server = createServer((request, response) => {
            let body = ''
            request.on('data', (chunk) => (body += chunk))
            request.on('end', () => {
                const parsed = JSON.parse(body) as { requestId: string }
                response.writeHead(200, { 'content-type': 'application/json' })
                response.end(
                    JSON.stringify({ decision: 'reject', optionId: `no-${parsed.requestId}` }),
                )
            })
        })
        servers.push(server)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        const port = typeof address === 'object' && address !== null ? address.port : 0
        const broker = new PermissionBroker({
            mode: 'callback',
            callbackUrl: `http://127.0.0.1:${port}/approve`,
            headers: {},
            timeoutMs: 5000,
            fallback: 'cancel',
        })
        const decision = await broker.decide({
            requestId: 'p2',
            sessionId: 's2',
            toolCall: {},
            options: [{ optionId: 'no-p2', kind: 'reject_once' }],
        })
        expect(decision.decision).toBe('reject')
        expect(decision.optionId).toBe('no-p2')
        expect(decision.source).toBe('callback')
    })
})

const request = {
    requestId: 'p3',
    sessionId: 's3',
    toolCall: { title: 'write file' },
    options: [
        { optionId: 'once', kind: 'allow_once' },
        { optionId: 'always', kind: 'allow_always' },
    ],
}

function broker(overrides: Partial<PermissionConfig> = {}): PermissionBroker {
    return new PermissionBroker({
        mode: 'callback',
        callbackUrl: null,
        headers: {},
        timeoutMs: 50,
        fallback: 'cancel',
        ...overrides,
    })
}

async function callbackServer(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/approve`
}

describe('permission policy branches', () => {
    it.each(['reject', 'cancel'] as const)('answers %s from policy', async (mode) => {
        const decision = await broker({ mode }).decide(request)
        expect(decision).toMatchObject({
            decision: mode,
            optionId: mode === 'cancel' ? null : 'once',
            source: 'policy',
        })
    })

    it('cancels a turn that was already aborted', async () => {
        const controller = new AbortController()
        controller.abort()
        const decision = await broker({ mode: 'allow' }).decide(request, controller.signal)
        expect(decision).toMatchObject({ decision: 'cancel', optionId: null, source: 'aborted' })
    })

    it('applies the fallback when no approval callback is configured', async () => {
        const decision = await broker({ fallback: 'reject' }).decide(request)
        expect(decision).toMatchObject({ decision: 'reject', optionId: 'once', source: 'fallback' })
        expect(decision.error).toMatch(/no approval callback configured/)
    })

    it('falls back to the first option when no kind matches the decision', async () => {
        const decision = await broker({ mode: 'reject' }).decide({
            ...request,
            options: [{ optionId: 'sole', kind: 'other' }],
        })
        expect(decision.optionId).toBe('sole')
    })

    it('chooses the option from a bare callback decision', async () => {
        const url = await callbackServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ decision: 'allow' }))
        })
        const decision = await broker({ callbackUrl: url, fallback: 'cancel' }).decide(request)
        expect(decision).toMatchObject({ decision: 'allow', optionId: 'once', source: 'callback' })
    })

    it('falls back when the callback answers with an error status', async () => {
        const url = await callbackServer((_request, response) => {
            response.writeHead(503)
            response.end('unavailable')
        })
        const decision = await broker({ callbackUrl: url, fallback: 'allow' }).decide(request)
        expect(decision).toMatchObject({ decision: 'allow', optionId: 'once', source: 'fallback' })
        expect(decision.error).toMatch(/HTTP 503/)
    })

    it('falls back when the callback times out', async () => {
        const url = await callbackServer(() => undefined)
        const decision = await broker({ callbackUrl: url, timeoutMs: 50, fallback: 'reject' }).decide(
            request,
        )
        expect(decision).toMatchObject({ decision: 'reject', source: 'fallback' })
    })
})

describe('permission outcome', () => {
    it('serializes a selection or a cancellation for ACP', () => {
        expect(
            permissionOutcome({ decision: 'allow', optionId: 'once', source: 'policy', elapsedMs: 1 }),
        ).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
        expect(
            permissionOutcome({ decision: 'reject', optionId: null, source: 'fallback', elapsedMs: 1 }),
        ).toEqual({ outcome: { outcome: 'cancelled' } })
    })
})

import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { PermissionBroker } from '../src/permission.js'

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

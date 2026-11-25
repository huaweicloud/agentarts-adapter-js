import { describe, expect, it } from 'vitest'

import { GatewayResolver, extractEndpoint } from '../src/gateway.js'

describe('gateway resolver', () => {
    it('uses Authorization: Bearer for an API-key gateway', async () => {
        const resolver = new GatewayResolver({ mcpUrl: 'https://gw.example.com/mcp', apiKey: 'k' })
        const resolved = await resolver.resolve()
        expect(resolved?.server.type).toBe('http')
        expect(resolved?.server.headers).toEqual([
            { name: 'Authorization', value: 'Bearer k' },
        ])
        expect(resolved?.meta.transport).toBe('http')
    })

    it('routes an SSE target through the stdio bridge', async () => {
        const client = {
            async getGateway() {
                return { success: true, data: { gateway: { authorizer_type: 'api_key' } } }
            },
            async getGatewayTarget() {
                return {
                    success: true,
                    data: {
                        target: {
                            target_id: 't1',
                            target_configuration: {
                                mcp_server: { endpoint: 'https://target.example.com/sse' },
                            },
                        },
                    },
                }
            },
        }
        const resolver = new GatewayResolver(
            {
                gatewayId: 'g1',
                targetId: 't1',
                apiKey: 'secret',
            },
            () => client,
        )
        const resolved = await resolver.resolve()
        expect(resolved?.meta.transport).toBe('sse-bridge')
        expect(resolved?.server.command).toBe(process.execPath)
        expect(resolved?.server.args?.[1]).toBe('https://target.example.com/sse')
        const headers = JSON.parse(resolved?.server.env?.[0]?.value ?? '{}') as Record<
            string,
            string
        >
        expect(headers.Authorization).toBe('Bearer secret')
    })

    it('extracts nested target endpoints', () => {
        const target = extractEndpoint({
            target_configuration: {
                mcpServer: { connection: { serverUrl: 'https://x/mcp' } },
            },
        })
        expect(target?.endpoint).toBe('https://x/mcp')
    })
})

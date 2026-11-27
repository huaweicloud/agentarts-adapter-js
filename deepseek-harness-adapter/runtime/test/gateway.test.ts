import { describe, expect, it } from 'vitest'

import {
    GatewayResolver,
    describeMcpServers,
    extractEndpoint,
    mergeMcpServers,
    normalizeMcpServers,
} from '../src/gateway.js'

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

    it('请求级凭据覆盖不复用缓存', async () => {
        const resolver = new GatewayResolver({ mcpUrl: 'https://gw.example.com/mcp' })
        const alice = await resolver.resolve({ apiKey: 'alice' })
        const bob = await resolver.resolve({ apiKey: 'bob' })
        expect(alice?.server.headers).toEqual([{ name: 'Authorization', value: 'Bearer alice' }])
        expect(bob?.server.headers).toEqual([{ name: 'Authorization', value: 'Bearer bob' }])
    })

    it('无凭据覆盖的解析复用 TTL 缓存', async () => {
        const resolver = new GatewayResolver({
            mcpUrl: 'https://gw.example.com/mcp',
            apiKey: 'shared',
        })
        const first = await resolver.resolve()
        const second = await resolver.resolve()
        expect(second).toBe(first)
    })
})

it('binds deployment credentials to the configured target and honors explicit request credentials', async () => {
    const resolver = new GatewayResolver({ mcpUrl: 'https://gateway.example/a', apiKey: 'deployment',
        headers: { 'x-custom': 'configured' } })
    expect((await resolver.resolve({ mcpUrl: 'https://gateway.example/b' }))?.server.headers).toEqual([])
    const other = await resolver.resolve({ mcpUrl: 'https://gateway.example/b', bearerToken: 'request' })
    expect(other?.server.headers).toEqual([{ name: 'Authorization', value: 'Bearer request' }])
    expect((await resolver.resolve())?.server.headers).toContainEqual({ name: 'Authorization', value: 'Bearer deployment' })
})

describe('mcp server normalization', () => {
    it('normalizes http headers and stdio env pairs from both shapes', () => {
        expect(
            normalizeMcpServers([
                {
                    name: 'http-one',
                    type: 'http',
                    url: 'https://mcp.example/mcp',
                    headers: [{ name: 'x-api-key', value: 'k' }],
                },
                { server_name: 'stdio-one', command: 'node', args: ['server.mjs'], env: { TOKEN: 't' } },
                { name: 'no-transport' },
                { type: 'http', url: 'https://nameless.example/mcp' },
                'not-an-object',
            ]),
        ).toEqual([
            {
                name: 'http-one',
                type: 'http',
                url: 'https://mcp.example/mcp',
                headers: [{ name: 'x-api-key', value: 'k' }],
            },
            {
                name: 'stdio-one',
                command: 'node',
                args: ['server.mjs'],
                env: [{ name: 'TOKEN', value: 't' }],
            },
        ])
    })

    it('rejects legacy sse servers instead of mounting them', () => {
        expect(() => normalizeMcpServers([{ name: 'sse-one', type: 'sse', url: 'https://x/sse' }]))
            .toThrowError(/does not support/)
    })

    it('ignores non-array input', () => {
        expect(normalizeMcpServers(undefined)).toEqual([])
        expect(normalizeMcpServers({ name: 'x', command: 'node' })).toEqual([])
    })
})

describe('mcp server merging and description', () => {
    it('dedupes case-insensitively with later entries winning', () => {
        const merged = mergeMcpServers(
            [{ name: 'Gateway', type: 'http', url: 'https://a.example/mcp' }],
            [
                { name: ' gateway ', type: 'http', url: 'https://b.example/mcp' },
                { name: 'other', command: 'node' },
            ],
        )
        expect(merged.map((server) => [server.name, server.url ?? server.command])).toEqual([
            [' gateway ', 'https://b.example/mcp'],
            ['other', 'node'],
        ])
    })

    it('redacts endpoints and exposes header/env names only', () => {
        expect(
            describeMcpServers([
                {
                    name: 'gw',
                    type: 'http',
                    url: 'https://user:secret@gw.example/mcp?token=abc#frag',
                    headers: [{ name: 'Authorization', value: 'Bearer secret' }],
                },
                { name: 'local', command: 'node', env: [{ name: 'TOKEN', value: 'secret' }] },
            ]),
        ).toEqual([
            {
                name: 'gw',
                type: 'http',
                url: 'https://gw.example/mcp',
                headerNames: ['Authorization'],
                envNames: [],
            },
            {
                name: 'local',
                type: 'stdio',
                command: 'node',
                headerNames: [],
                envNames: ['TOKEN'],
            },
        ])
    })
})

describe('gateway control plane resolution', () => {
    const target = (targetId: string, targetName: string, endpoint: string) => ({
        target_id: targetId,
        target_name: targetName,
        target_configuration: { mcp_server: { endpoint } },
    })

    it('picks a target by name and reuses the authorizer credential', async () => {
        const client = {
            async getGateway() {
                return {
                    success: true,
                    data: {
                        gateway: {
                            authorizer_type: 'api_key',
                            authorizer_configuration: { header_name: 'x-api-key', api_key: 'authorizer' },
                        },
                    },
                }
            },
            async listGatewayTargets() {
                return {
                    success: true,
                    data: {
                        targets: [
                            target('t1', 'Alpha', 'https://a.example/mcp'),
                            target('t2', 'Beta', 'https://b.example/mcp'),
                        ],
                    },
                }
            },
            async getGatewayTarget() {
                return { success: true, data: { target: target('t2', 'Beta', 'https://b.example/mcp') } }
            },
        }
        const resolver = new GatewayResolver({ gatewayId: 'g1', targetName: 'beta' }, () => client)
        const resolved = await resolver.resolve()
        expect(resolved?.server.url).toBe('https://b.example/mcp')
        expect(resolved?.server.headers).toEqual([{ name: 'x-api-key', value: 'authorizer' }])
        expect(resolved?.meta).toMatchObject({
            source: 'control-plane',
            transport: 'http',
            targetId: 't2',
            targetName: 'Beta',
            authType: 'api_key',
        })
        expect(resolved?.meta.endpoint).toBe('https://b.example/mcp')
    })

    it('reports an unknown target name', async () => {
        const client = {
            async getGateway() {
                return { success: true, data: {} }
            },
            async listGatewayTargets() {
                return { success: true, data: { targets: [target('t1', 'Alpha', 'https://a/mcp')] } }
            },
        }
        const resolver = new GatewayResolver({ gatewayId: 'g1', targetName: 'missing' }, () => client)
        await expect(resolver.resolve()).rejects.toMatchObject({
            code: 'gateway_target_not_found',
            statusCode: 404,
        })
    })

    it('reports a control-plane listing failure', async () => {
        const client = {
            async getGateway() {
                return { success: false, error: 'denied' }
            },
            async listGatewayTargets() {
                return { success: false, error: 'denied' }
            },
        }
        const resolver = new GatewayResolver({ gatewayId: 'g1' }, () => client)
        await expect(resolver.resolve()).rejects.toMatchObject({
            code: 'gateway_target_unavailable',
            statusCode: 502,
        })
    })

    it('reports a target without a usable endpoint', async () => {
        const client = {
            async getGateway() {
                return { success: true, data: {} }
            },
            async getGatewayTarget() {
                return { success: true, data: { target: { target_id: 't1' } } }
            },
        }
        const resolver = new GatewayResolver({ gatewayId: 'g1', targetId: 't1' }, () => client)
        await expect(resolver.resolve()).rejects.toMatchObject({
            code: 'gateway_target_endpoint_missing',
            statusCode: 502,
        })
    })

    it('requires either an MCP URL or a gateway id', async () => {
        await expect(new GatewayResolver({ enabled: true }).resolve()).rejects.toMatchObject({
            code: 'gateway_target_unavailable',
            statusCode: 400,
        })
    })

    it('honors an explicit http transport for an /sse endpoint', async () => {
        const resolver = new GatewayResolver({ mcpUrl: 'https://gw.example/sse', transport: 'http' })
        expect((await resolver.resolve())?.meta.transport).toBe('http')
    })

    it('ignores non-object target payloads', () => {
        expect(extractEndpoint('plain-text')).toBeNull()
        expect(extractEndpoint(null)).toBeNull()
    })
})

import { GatewayClient } from '@huaweicloud/agentarts-sdk'

import type { AcpMcpServer, GatewayConfig } from './types.js'
import { RuntimeError } from './errors.js'
import { SSE_BRIDGE } from './config.js'

interface GatewayTargetShape {
    targetId?: string
    targetName?: string
    endpoint?: string
    serverType?: string | null
    raw?: unknown
}

export interface GatewayResolution {
    server: AcpMcpServer
    meta: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
}

function pickString(object: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = object[key]
        if (typeof value === 'string' && value !== '') return value
    }
    return undefined
}

function parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') return value
    const text = value.trim()
    if (!text.startsWith('{') && !text.startsWith('[')) return value
    try {
        return JSON.parse(text)
    } catch {
        return value
    }
}

/** Extract the MCP endpoint from the various AgentArts target payload shapes. */
export function extractEndpoint(target: unknown): GatewayTargetShape | null {
    const root = asRecord(parseMaybeJson(target))
    if (root === null) return null
    const record = asRecord(parseMaybeJson(root.target)) ?? root
    const configuration =
        asRecord(parseMaybeJson(record.target_configuration)) ??
        asRecord(parseMaybeJson(record.targetConfiguration)) ??
        record
    const server =
        asRecord(parseMaybeJson(configuration.mcp_server)) ??
        asRecord(parseMaybeJson(configuration.mcpServer)) ??
        asRecord(parseMaybeJson(configuration.server)) ??
        configuration
    const connection =
        asRecord(parseMaybeJson(server.connection)) ??
        asRecord(parseMaybeJson(server.connection_configuration)) ??
        server
    const endpoint = pickString(connection, [
        'endpoint',
        'url',
        'serverUrl',
        'server_url',
        'address',
        'mcpUrl',
        'mcp_url',
    ]) ?? pickString(server, ['endpoint', 'url', 'serverUrl', 'server_url'])
    if (endpoint === undefined) return null
    return {
        targetId: pickString(record, ['target_id', 'targetId', 'id']),
        targetName: pickString(record, ['target_name', 'targetName', 'name']),
        endpoint,
        serverType:
            pickString(server, ['server_type', 'serverType', 'type']) ??
            pickString(configuration, ['server_type', 'serverType']) ??
            null,
        raw: target,
    }
}

function authorizerInfo(gateway: unknown): {
    authType: string | null
    headerName: string | null
    authorizerKey: string | null
} {
    const root = asRecord(gateway)
    if (root === null) return { authType: null, headerName: null, authorizerKey: null }
    const info = asRecord(root.gateway) ?? root
    const authTypeRaw = pickString(info, ['authorizer_type', 'authorizerType'])
    const authType = authTypeRaw?.toLowerCase() ?? null
    const configuration =
        asRecord(info.authorizer_configuration) ?? asRecord(info.authorizerConfiguration) ?? {}
    const nested =
        asRecord(configuration.api_key_configuration) ??
        asRecord(configuration.apiKeyConfiguration) ??
        configuration
    const headerName =
        pickString(configuration, ['header_name', 'headerName', 'api_key_header', 'apiKeyHeader']) ??
        pickString(nested, ['header_name', 'headerName'])
    const authorizerKey =
        pickString(nested, ['api_key', 'apiKey', 'key', 'value', 'secret']) ?? null
    return { authType, headerName: headerName ?? null, authorizerKey }
}

function buildHeaders(config: GatewayConfig, gateway: unknown): {
    headers: Array<{ name: string; value: string }>
    authType: string | null
} {
    const info = authorizerInfo(gateway)
    const authType = info.authType
    const apiKey = config.apiKey ?? (config.useAuthorizerKey === false ? undefined : info.authorizerKey) ?? undefined
    const apiKeyHeader =
        config.apiKeyHeader ??
        info.headerName ??
        (authType === 'api_key' || apiKey !== undefined ? 'Authorization' : 'x-api-key')
    const apiKeyPrefix =
        apiKeyHeader.toLowerCase() === 'authorization' && !apiKeyHeader.toLowerCase().includes('bearer')
            ? 'Bearer '
            : ''

    const headers: Array<{ name: string; value: string }> = []
    for (const [name, value] of Object.entries(config.headers ?? {})) {
        headers.push({ name, value })
    }
    if (apiKey !== undefined) {
        headers.push({ name: apiKeyHeader, value: `${apiKeyPrefix}${apiKey}`.trim() })
    }
    if (config.bearerToken !== undefined) {
        headers.push({ name: 'Authorization', value: `Bearer ${config.bearerToken}` })
    }
    if (config.accessToken !== undefined) {
        headers.push({
            name: config.accessTokenHeader ?? 'X-HW-AgentGateway-Workload-Access-Token',
            value: config.accessToken,
        })
    }
    if (config.userId !== undefined) {
        headers.push({
            name: config.userIdHeader ?? 'X-HW-AgentGateway-User-Id',
            value: config.userId,
        })
    }
    return { headers, authType }
}

function redactUrl(value: string): string {
    try {
        const url = new URL(value)
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        return url.href
    } catch {
        return '(configured)'
    }
}

export class GatewayResolver {
    private cache = new Map<string, { value: GatewayResolution; expiresAt: number }>()

    constructor(
        private readonly config: GatewayConfig,
        private readonly clientFactory: () => any = () => new GatewayClient(),
    ) {}

    async resolve(override: GatewayConfig = {}): Promise<GatewayResolution | null> {
        const config = { ...this.config, ...override }
        const enabled =
            config.enabled ??
            (config.mcpUrl !== undefined || config.gatewayId !== undefined)
        if (!enabled) return null
        const key = JSON.stringify({
            mcpUrl: config.mcpUrl,
            gatewayId: config.gatewayId,
            targetId: config.targetId,
            targetName: config.targetName,
            transport: config.transport,
        })
        const cached = this.cache.get(key)
        const now = Date.now()
        if (cached !== undefined && cached.expiresAt > now) return cached.value

        const { endpoint, target, gateway } = await this.resolveEndpoint(config)
        const { headers, authType } = buildHeaders(config, gateway)
        const serverType = target?.serverType ?? config.serverType ?? null
        const useSse =
            config.transport === 'sse' ||
            (config.transport !== 'http' &&
                ((serverType ?? '').toLowerCase().includes('sse') || /\/sse\/?$/.test(endpoint)))
        const name = config.serverName ?? 'agentarts-gateway'

        if (useSse && config.transport !== 'http') {
            const server: AcpMcpServer = {
                name,
                command: process.execPath,
                args: [SSE_BRIDGE, endpoint],
                env: [
                    {
                        name: 'MCP_BRIDGE_HEADERS',
                        value: JSON.stringify(
                            Object.fromEntries(
                                headers.map((header) => [header.name, header.value]),
                            ),
                        ),
                    },
                ],
            }
            const meta = this.meta(config, target, endpoint, 'sse-bridge', authType, headers)
            const value = { server, meta }
            this.cache.set(key, {
                value,
                expiresAt: now + (config.cacheTtlMs ?? 300_000),
            })
            return value
        }

        const server: AcpMcpServer = {
            name,
            type: 'http',
            url: endpoint,
            headers,
        }
        const value = {
            server,
            meta: this.meta(config, target, endpoint, 'http', authType, headers),
        }
        this.cache.set(key, { value, expiresAt: now + (config.cacheTtlMs ?? 300_000) })
        return value
    }

    private meta(
        config: GatewayConfig,
        target: GatewayTargetShape | null,
        endpoint: string,
        transport: string,
        authType: string | null,
        headers: Array<{ name: string; value: string }>,
    ): Record<string, unknown> {
        return {
            source: config.mcpUrl === undefined ? 'control-plane' : 'direct',
            transport,
            gatewayId: config.gatewayId ?? null,
            targetId: target?.targetId ?? config.targetId ?? null,
            targetName: target?.targetName ?? config.targetName ?? null,
            endpoint: redactUrl(endpoint),
            authType,
            headerNames: headers.map((header) => header.name),
        }
    }

    private async resolveEndpoint(config: GatewayConfig): Promise<{
        endpoint: string
        target: GatewayTargetShape | null
        gateway: unknown
    }> {
        if (config.mcpUrl !== undefined) {
            return { endpoint: config.mcpUrl, target: null, gateway: null }
        }
        if (config.gatewayId === undefined) {
            throw new RuntimeError('gateway.mcpUrl or gateway.gatewayId is required', {
                code: 'gateway_target_unavailable',
                statusCode: 400,
            })
        }
        const client = this.clientFactory()
        let gateway: unknown = null
        try {
            const result = await client.getGateway(config.gatewayId)
            if (result?.success === true) gateway = result.data?.gateway ?? result.data
        } catch {
            // Authorizer metadata is optional; target resolution can still work.
        }

        let targetPayload: unknown = null
        if (config.targetId !== undefined) {
            const result = await client.getGatewayTarget(config.gatewayId, config.targetId)
            if (result?.success === false) {
                throw new RuntimeError(`gateway target lookup failed: ${String(result.error)}`, {
                    code: 'gateway_target_unavailable',
                    statusCode: 502,
                })
            }
            targetPayload = result?.data?.target ?? result?.data
        } else {
            const result = await client.listGatewayTargets(config.gatewayId)
            if (result?.success === false) {
                throw new RuntimeError(`gateway target list failed: ${String(result.error)}`, {
                    code: 'gateway_target_unavailable',
                    statusCode: 502,
                })
            }
            const rows = (result?.data?.targets ?? result?.data?.items ?? []) as unknown[]
            const wanted = config.targetName?.toLowerCase()
            const row = rows
                .map((item) => asRecord(item))
                .find((item): item is Record<string, unknown> => {
                    if (item === null) return false
                    const name = pickString(item, ['target_name', 'targetName', 'name'])
                    return wanted === undefined || name?.toLowerCase() === wanted
                })
            if (row === undefined) {
                throw new RuntimeError(
                    wanted === undefined
                        ? 'no gateway target found'
                        : `gateway target not found: ${config.targetName}`,
                    { code: 'gateway_target_not_found', statusCode: 404 },
                )
            }
            const id =
                pickString(row, ['target_id', 'targetId', 'id']) ??
                pickString(row, ['target_name', 'targetName', 'name'])
            if (id !== undefined) {
                const result = await client.getGatewayTarget(config.gatewayId, id)
                targetPayload =
                    result?.success === true
                        ? (result.data?.target ?? result.data)
                        : row
            } else {
                targetPayload = row
            }
        }

        const target = extractEndpoint(targetPayload)
        if (target === null) {
            throw new RuntimeError('gateway target endpoint is missing', {
                code: 'gateway_target_endpoint_missing',
                statusCode: 502,
                data: { targetId: config.targetId, targetName: config.targetName },
            })
        }
        return { endpoint: target.endpoint as string, target, gateway }
    }
}

/** Normalize request-level MCP servers to the exact ACP/DSH shape. */
export function normalizeMcpServers(value: unknown): AcpMcpServer[] {
    if (!Array.isArray(value)) return []
    const result: AcpMcpServer[] = []
    for (const item of value) {
        const record = asRecord(item)
        if (record === null) continue
        const name = pickString(record, ['name', 'serverName', 'server_name'])
        if (name === undefined) continue
        const type = record.type
        if (type === 'sse') {
            throw new RuntimeError('ACP does not support type:"sse"; use the gateway SSE bridge', {
                code: 'mcp_sse_unsupported',
                statusCode: 400,
            })
        }
        if (type === 'http') {
            const url = pickString(record, ['url', 'endpoint'])
            if (url === undefined) continue
            result.push({
                name,
                type: 'http',
                url,
                headers: normalizeHeaderPairs(record.headers),
            })
            continue
        }
        const command = pickString(record, ['command'])
        if (command === undefined) continue
        result.push({
            name,
            command,
            args: Array.isArray(record.args) ? record.args.map(String) : [],
            env: normalizeEnvPairs(record.env),
        })
    }
    return result
}

function normalizeHeaderPairs(value: unknown): Array<{ name: string; value: string }> {
    if (Array.isArray(value)) {
        return value
            .map((item) => asRecord(item))
            .filter((item): item is Record<string, unknown> => item !== null)
            .map((item) => ({
                name: String(item.name ?? ''),
                value: String(item.value ?? ''),
            }))
            .filter((item) => item.name !== '')
    }
    const record = asRecord(value)
    return record === null
        ? []
        : Object.entries(record).map(([name, headerValue]) => ({
              name,
              value: String(headerValue),
          }))
}

function normalizeEnvPairs(value: unknown): Array<{ name: string; value: string }> {
    if (Array.isArray(value)) {
        return value
            .map((item) => asRecord(item))
            .filter((item): item is Record<string, unknown> => item !== null)
            .map((item) => ({
                name: String(item.name ?? ''),
                value: String(item.value ?? ''),
            }))
            .filter((item) => item.name !== '')
    }
    const record = asRecord(value)
    return record === null
        ? []
        : Object.entries(record).map(([name, envValue]) => ({
              name,
              value: String(envValue),
          }))
}

/** Merge MCP server lists by name (later wins), preserving stable order. */
export function mergeMcpServers(
    base: AcpMcpServer[],
    extra: AcpMcpServer[],
): AcpMcpServer[] {
    const map = new Map<string, AcpMcpServer>()
    for (const server of [...base, ...extra]) {
        map.set(server.name.trim().toLowerCase(), server)
    }
    return [...map.values()]
}

export function describeMcpServers(servers: AcpMcpServer[]): Array<Record<string, unknown>> {
    return servers.map((server) => ({
        name: server.name,
        type: server.type === 'http' ? 'http' : 'stdio',
        ...(server.url === undefined ? {} : { url: redactUrl(server.url) }),
        ...(server.command === undefined ? {} : { command: server.command }),
        headerNames: (server.headers ?? []).map((header) => header.name),
        envNames: (server.env ?? []).map((entry) => entry.name),
    }))
}

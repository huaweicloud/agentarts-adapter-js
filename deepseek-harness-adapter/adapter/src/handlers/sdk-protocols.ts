import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { AgentArtsRuntimeApp, FileProtocolStorage, type ProtocolAuthenticator } from '@huaweicloud/agentarts-sdk/sdk/runtime'
import { AgentCard, Artifact, createA2aService } from '@huaweicloud/agentarts-protocol-a2a'
import { EventType, createAguiAgent } from '@huaweicloud/agentarts-protocol-agui'
import type { HarnessEvent, HarnessRunner } from '../runner.js'

function sessionKey(principal: { tenantId: string; subject: string }, id: string) {
    return createHash('sha256').update(JSON.stringify([principal.tenantId, principal.subject, id])).digest('hex')
}

async function executeTurn(runner: HarnessRunner, sessionId: string, prompt: string, signal: AbortSignal,
    publish: (event: HarnessEvent) => void | Promise<void>) {
    if (!prompt.trim()) throw new Error('A user text message is required')
    const turn = await runner.runTurn({ sessionId, prompt }, signal)
    try {
        for await (const event of turn.events) {
            if (signal.aborted) break
            await publish(event)
        }
        const result = await turn.result
        if (!result.ok && !signal.aborted) throw new Error(result.error?.message ?? result.stopReason)
        return result
    } finally {
        turn.cancel()
        await turn.result
    }
}

/** SDK full-service example configuration. The token identifies one deployment principal. */
export function configureProtocols(app: AgentArtsRuntimeApp, runner: HarnessRunner, mainPort: number, env = process.env) {
    const token = env.AGENTARTS_PROTOCOL_TOKEN
    if (!token) {
        if (env.AGENTARTS_PROTOCOL_PUBLIC_ORIGIN || env.A2A_PORT || env.AGENTARTS_PROTOCOL_STORAGE_DIR)
            throw new Error('AGENTARTS_PROTOCOL_TOKEN is required for protocol configuration')
        return
    }
    if (Buffer.byteLength(token) < 32) throw new Error('AGENTARTS_PROTOCOL_TOKEN must contain at least 32 bytes')
    const expected = Buffer.from('Bearer ' + token)
    const authenticate: ProtocolAuthenticator = ({ headers }) => {
        const value = Buffer.from(typeof headers.authorization === 'string' ? headers.authorization : '')
        return value.length === expected.length && timingSafeEqual(value, expected)
            ? { tenantId: 'deployment', subject: 'protocol-client' } : null
    }
    const port = Number(env.A2A_PORT ?? 8001)
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === mainPort) throw new Error('Invalid or conflicting A2A_PORT')
    const origin = new URL(env.AGENTARTS_PROTOCOL_PUBLIC_ORIGIN ?? 'http://127.0.0.1:' + port).origin
    const key = env.AGENTARTS_PROTOCOL_STORAGE_KEY
    if (key !== undefined && !/^[\da-f]{64}$/i.test(key)) throw new Error('Invalid AGENTARTS_PROTOCOL_STORAGE_KEY')
    const storage = new FileProtocolStorage(env.AGENTARTS_PROTOCOL_STORAGE_DIR ?? '.agentarts-protocol',
        key ? { encryptionKey: Buffer.from(key, 'hex') } : {})
    const allowedOrigins = env.AGENTARTS_PROTOCOL_ORIGINS?.split(',').map(x => x.trim()).filter(Boolean)

    app.use(createAguiAgent({ authenticate, storage, allowedOrigins, async execute(input, ctx) {
        const last = input.messages.at(-1)
        if (last?.role !== 'user') throw new Error('Expected a user message at the end of the turn')
        const content = last.content
        const prompt = typeof content === 'string' ? content : (content ?? []).map(part => {
            if (part.type !== 'text') throw new Error('Only text input is supported')
            return part.text
        }).join('\n')
        // Emit server-side tool activity with the harness call ID. These tools already ran on the server.
        const history = [...input.messages]
        const textId = randomUUID()
        let text = ''
        let opened = false
        let corrected = false
        const result = await executeTurn(runner, sessionKey(ctx.principal, input.threadId), prompt, ctx.signal, e => {
            if (e.type === 'text_delta' && e.channel === 'message') {
                if (!opened) {
                    ctx.emit({ type: EventType.TEXT_MESSAGE_START, role: 'assistant', messageId: textId })
                    opened = true
                }
                const delta = String(e.delta)
                text += delta
                ctx.emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: textId, delta })
            } else if (e.type === 'text_correction' && e.channel === 'message') {
                corrected = true
            } else if (e.type === 'tool_call') {
                const id = String(e.toolCallId), name = String(e.name ?? e.title ?? 'tool')
                const args = JSON.stringify(e.rawInput ?? {})
                ctx.emit({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name })
                ctx.emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: args })
                ctx.emit({ type: EventType.TOOL_CALL_END, toolCallId: id })
                history.push({ role: 'assistant', id: randomUUID(), toolCalls: [{ id, type: 'function', function: { name, arguments: args } }] })
            } else if (e.type === 'tool_call_update' && ['completed', 'failed'].includes(String(e.status))) {
                const id = String(e.toolCallId), messageId = randomUUID()
                const content = JSON.stringify(e.rawOutput ?? e.content ?? e.status)
                ctx.emit({ type: EventType.TOOL_CALL_RESULT, messageId, toolCallId: id, content })
                history.push({ role: 'tool', id: messageId, toolCallId: id, content })
            }
        })
        if (opened) ctx.emit({ type: EventType.TEXT_MESSAGE_END, messageId: textId })
        if (ctx.signal.aborted) return { outcome: { type: 'cancelled' } }
        if (!opened && result.output) ctx.emitText(result.output)
        else if (corrected || text !== result.output) {
            history.push({ role: 'assistant', id: textId, content: result.output })
            ctx.emit({ type: EventType.MESSAGES_SNAPSHOT, messages: history })
        }
        return { result: { stopReason: result.stopReason } }
    } }))

    const service = createA2aService({ runtime: app, authenticate, storage, allowedOrigins,
        agentCard: AgentCard.fromJSON({ name: 'AgentArts Harness', description: 'Managed harness text agent', version: '1.0',
            supportedInterfaces: [{ url: origin + '/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
                { url: origin + '/a2a/rest', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
            defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [],
            securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer' } } },
            securityRequirements: [{ schemes: { bearer: { list: [] } } }],
        }),
        async execute(message, ctx) {
            const prompt = message.parts.map(part => {
                if (part.content?.$case !== 'text') throw new Error('Only text input is supported')
                return part.content.value
            }).join('\n')
            let text = '', published: string | undefined
            const publish = async (value: string) => {
                await ctx.emitArtifact(Artifact.fromJSON({ artifactId: 'answer', parts: [{ text: value, mediaType: 'text/plain' }] }))
                published = value
            }
            const result = await executeTurn(runner, sessionKey(ctx.principal, ctx.task.contextId), prompt, ctx.signal, async e => {
                if (e.type === 'text_delta' && e.channel === 'message') {
                    text += String(e.delta)
                    if (published === undefined || text.length - published.length >= 4096) await publish(text)
                } else if (e.type === 'text_correction' && e.channel === 'message') {
                    text = String(e.text)
                }
            })
            if (!ctx.signal.aborted && published !== result.output) await publish(result.output)
        },
    })
    return { server: createServer(service.http), port }
}

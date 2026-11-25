#!/usr/bin/env node
/**
 * Minimal ACP fixture: initialize, session/new, session/prompt.
 * Emits token-marked chunks followed by the committed block, then end_turn.
 */
import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
let sessionId = 'fake-session'
let attempt = 0

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`)
}

function update(update) {
    send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update },
    })
}

lines.on('line', (line) => {
    let message
    try {
        message = JSON.parse(line)
    } catch {
        return
    }
    if (message.id === undefined) return
    const reply = (result) =>
        send({ jsonrpc: '2.0', id: message.id, result })

    if (message.method === 'initialize') {
        reply({
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: { name: 'fake-acp', version: '1.0.0' },
        })
        return
    }
    if (message.method === 'session/new') {
        sessionId = `fake-${++attempt}`
        reply({ sessionId, configOptions: [] })
        return
    }
    if (message.method === 'session/prompt') {
        const text = 'Hello'
        update({
            sessionUpdate: 'agent_message_chunk',
            messageId: 'token-a1',
            content: { type: 'text', text: 'Hel' },
            _meta: { 'dsh-acp/token': true, attemptId: 'a1', revision: 1 },
        })
        update({
            sessionUpdate: 'agent_message_chunk',
            messageId: 'token-a1',
            content: { type: 'text', text: 'lo' },
            _meta: { 'dsh-acp/token': true, attemptId: 'a1', revision: 2 },
        })
        update({
            sessionUpdate: 'agent_message_chunk',
            messageId: 'committed-a1',
            content: { type: 'text', text },
        })
        update({
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'echo',
            name: 'echo',
            kind: 'other',
            status: 'pending',
            rawInput: { text },
        })
        update({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            status: 'completed',
            rawOutput: { ok: true },
        })
        reply({ stopReason: 'end_turn' })
        return
    }
    if (message.method === 'session/close') {
        reply({})
        return
    }
    if (message.method === 'session/set_config_option') {
        reply({ configOptions: [] })
        return
    }
    reply({})
})

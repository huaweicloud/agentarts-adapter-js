/** Exercise the installed SDK and compiled production entry point through real transports. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const local = path => fileURLToPath(new URL(path, import.meta.url))
async function port() {
    const server = createServer().listen(0, '127.0.0.1')
    await once(server, 'listening')
    const value = server.address().port
    await new Promise(resolve => server.close(resolve))
    return value
}
const dir = await mkdtemp(join(tmpdir(), 'agentarts-smoke-'))
const main = await port(), a2a = await port()
const base = 'http://127.0.0.1:' + main, rpc = 'http://127.0.0.1:' + a2a
const token = randomUUID()
const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
const post = (url, body, extra = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...extra },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
const child = spawn(process.execPath, [local('../adapter/dist/main.js')], {
    cwd: dir, env: { ...process.env, AGENT_RUNTIME_TYPE: 'DSH', AGENT_SERVER_HOST: '127.0.0.1',
        AGENTRUN_MAX_CONCURRENCY: '2', AGENT_SERVER_PORT: String(main), A2A_PORT: String(a2a), DSH_AGENT_CWD: dir,
        AGENTARTS_PROTOCOL_TOKEN: token, AGENTARTS_PROTOCOL_PUBLIC_ORIGIN: rpc,
        AGENTARTS_PROTOCOL_STORAGE_DIR: dir, AGENTARTS_EVENT_STORAGE_DIR: dir,
        DSH_ACP_COMMAND: process.execPath, DSH_ACP_ARGS: JSON.stringify(local('../runtime/test/fixtures/fake-acp.mjs').replaceAll('\\', '/')),
    }, stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
for (const pipe of [child.stdout, child.stderr]) pipe.on('data', data => { logs = (logs + data).slice(-4000) })
const exited = once(child, 'exit')
let ws
try {
    const deadline = Date.now() + 25000
    for (;;) {
        const ping = await fetch(base + '/ping').then(r => r.json()).catch(() => null)
        if (ping?.status === 'Healthy') break
        if (Date.now() >= deadline || child.exitCode !== null) throw new Error('Readiness failed: ' + logs)
        await sleep(100)
    }
    const idHeader = 'x-hw-agentarts-session-id'
    const bad = await post(base + '/invocations', {}, { [idHeader]: 'rounds' })
    assert.equal(bad.status, 400)
    assert.equal(bad.headers.get(idHeader), 'rounds')
    const json = await post(base + '/invocations', { prompt: 'hello', stream: false }, { [idHeader]: 'rounds' })
    assert.equal((await json.json()).output, 'Hello')
    const sse = await post(base + '/invocations', { prompt: 'again' }, { [idHeader]: 'rounds' })
    assert.equal(sse.headers.get(idHeader), 'rounds')
    assert.match(await sse.text(), /"reused":true/)
    const payload = { prompt: 'retry', sessionId: 'rounds', eventId: 'evt-1' }
    assert.match(await (await post(base + '/invocations', payload)).text(), /run_started/)
    const replay = await (await post(base + '/invocations', { ...payload, attempt: 2 })).text()
    assert.match(replay, /run_finished/)
    assert.doesNotMatch(replay, /run_started/)
    assert.equal((await post(base + '/invocations', { ...payload, prompt: 'changed' })).status, 409)
    const controller = new AbortController()
    const hanging = await fetch(base + '/invocations', { method: 'POST', headers,
        body: JSON.stringify({ sessionId: 'disconnect', prompt: 'hang' }), signal: controller.signal })
    const reader = hanging.body.getReader()
    assert.equal((await reader.read()).done, false)
    controller.abort()
    const following = await post(base + '/invocations', { sessionId: 'disconnect', prompt: 'next', stream: false })
    assert.equal((await following.json()).output, 'Hello')
    ws = new WebSocket(base.replace('http:', 'ws:') + '/ws')
    await once(ws, 'open', { signal: AbortSignal.timeout(5000) })
    const end = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS terminal missing')), 5000)
        ws.addEventListener('message', event => {
            const frame = JSON.parse(event.data)
            if (frame.type === 'error' || frame.type === 'final') { clearTimeout(timer); resolve(frame) }
        })
    })
    ws.send(JSON.stringify({ sessionId: 'rounds', prompt: 'again' }))
    assert.equal((await end).text, 'Hello')
    ws.close()
    const card = await fetch(rpc + '/.well-known/agent-card.json', { headers })
    assert.equal(card.status, 200)
    const response = await post(rpc + '/a2a', { jsonrpc: '2.0', id: 1, method: 'SendMessage',
        params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }] },
            configuration: { returnImmediately: false } } }, { 'a2a-version': '1.0' })
    const body = await response.json()
    assert.match(JSON.stringify(body.result ?? body), /Hello/, JSON.stringify(body))
    const task = async (method, params) => {
        const response = await post(rpc + '/a2a', { jsonrpc: '2.0', id: 2, method, params }, { 'a2a-version': '1.0' })
        const reply = await response.json()
        assert.ok(reply.result, JSON.stringify(reply))
        return reply.result
    }
    const pending = await task('SendMessage', { message: { messageId: 'm2', role: 'ROLE_USER', parts: [{ text: 'hang' }] },
        configuration: { returnImmediately: true } })
    const taskId = pending.task?.id ?? pending.id
    assert.ok(taskId)
    const subscriber = new AbortController()
    const subscription = await fetch(rpc + '/a2a', { method: 'POST',
        headers: { ...headers, 'a2a-version': '1.0', accept: 'text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'SubscribeToTask', params: { id: taskId } }),
        signal: AbortSignal.any([subscriber.signal, AbortSignal.timeout(5000)]) })
    assert.match(subscription.headers.get('content-type') ?? '', /text\/event-stream/)
    await subscription.body.getReader().read()
    subscriber.abort()
    const stillRunning = await task('GetTask', { id: taskId })
    assert.match(JSON.stringify(stillRunning), /WORKING/i)
    const held = new AbortController()
    const heldResponse = await fetch(base + '/invocations', { method: 'POST', headers,
        body: JSON.stringify({ sessionId: 'capacity', prompt: 'hang' }), signal: held.signal })
    await heldResponse.body.getReader().read()
    assert.equal((await (await fetch(base + '/ping')).json()).status, 'HealthyBusy')
    assert.equal((await post(base + '/invocations', { prompt: 'probe' })).status, 503)
    held.abort()
    const cancelled = await task('CancelTask', { id: taskId })
    assert.match(JSON.stringify(cancelled), /CANCEL[L]?ED/i)
    const agui = await post(base + '/ag-ui', { threadId: 'thread', runId: 'r1',
        messages: [{ id: 'u', role: 'user', content: 'hi' }] })
    const events = await agui.text()
    assert.match(events, /TEXT_MESSAGE_CONTENT/)
    assert.match(events, /TOOL_CALL_RESULT/)
    assert.match(events, /RUN_FINISHED/)
    assert.doesNotMatch(events, /RUN_ERROR/)
    console.log('OK: readiness, JSON, SSE, WS, A2A task and AG-UI text/tool lifecycle')
} catch (error) {
    console.error(logs)
    throw error
} finally {
    ws?.close()
    child.kill()
    await exited
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/** Run the packaged rc.3 CLI and both adapter plugins with a loopback-only model. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { AcpRuntime, loadConfig } from '../runtime/dist/index.js'

const cli = process.argv[2]
if (!cli) throw new Error('Usage: node scripts/smoke-acp.mjs path/to/@deepseek-ai/dsh/lib/bin.js')
const root = await mkdtemp(path.join(tmpdir(), 'agentarts-real-acp-'))
const modelRequests = []
const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    if (!req.url?.includes('/messages')) { res.writeHead(404).end(); return }
    modelRequests.push(JSON.parse(body))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
        { type: 'message_start', message: { id: 'local', type: 'message', role: 'assistant', model: 'fixture',
            content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'local answer' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
    ]) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
    res.end()
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
let runtime
try {
    const base = 'http://127.0.0.1:' + server.address().port + '/anthropic'
    const patch = path.join(root, 'local-model.yaml')
    await writeFile(patch, JSON.stringify([
        { id: 'llm-deepseek', config: { baseURL: base, models: [{ id: 'fixture' }] } },
        { id: 'acp', config: { provider: 'deepseek-official', model: 'fixture' } },
        { id: 'session-persistence-jsonl', config: { root: path.join(root, 'sessions'), compression: 'none' } },
    ]))
    const cfg = loadConfig({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root,
        HOME: root, USERPROFILE: root, DSH_HOME: path.join(root, '.dsh'), DSH_AGENT_CWD: root, DSH_ACP_MODEL: 'fixture',
        DEEPSEEK_API_KEY: 'local-only', DEEPSEEK_BASE_URL: base, DSH_TELEMETRY_DISABLED: '1' })
    cfg.acpCommand = process.execPath
    cfg.acpArgs = [path.resolve(cli), ...cfg.acpArgs, '--patch', patch]
    cfg.promptTimeoutMs = 15000
    runtime = new AcpRuntime(cfg)
    await runtime.start()
    for (const reused of [false, true]) {
        const run = await runtime.runTurn({ sessionId: 'real', prompt: 'say hello', systemPrompt: 'local-smoke-persona' })
        const events = []
        for await (const e of run.events) events.push(e)
        const result = await run.result
        assert.equal(result.output, 'local answer', JSON.stringify(result.error))
        assert.ok(events.some(e => e.type === 'session' && e.reused === reused))
        assert.ok(events.some(e => e.type === 'text_delta' && e.token === true), 'token plugin')
    }
    assert.ok(modelRequests.some(request => JSON.stringify(request.system).includes('local-smoke-persona')), 'system prompt plugin')
    console.log('OK: real DSH ACP handshake, token plugin, system prompt injection and session reuse')
} finally {
    await runtime?.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

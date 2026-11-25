import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AcpRuntime } from '../src/runtime.js'
import { loadConfig } from '../src/config.js'
import type { RuntimeConfig, RuntimeEvent } from '../src/types.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))
const dirs: string[] = []

function config(): RuntimeConfig {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'acp-workspace-'))
    dirs.push(workspace)
    return loadConfig({
        DSH_ACP_COMMAND: process.execPath,
        DSH_ACP_ARGS: fixture,
        DSH_AGENT_CWD: workspace,
        DSH_ACP_PERMISSION_MODE: 'allow',
        DSH_ACP_PROMPT_TIMEOUT_MS: '5000',
    })
}

afterEach(() => {
    for (const directory of dirs.splice(0)) {
        rmSync(directory, { recursive: true, force: true })
    }
})

describe('ACP runtime', () => {
    it('streams token events and uses the committed text as final output', async () => {
        const runtime = new AcpRuntime(config())
        const handle = await runtime.runTurn({ sessionId: 's1', prompt: 'hi' })
        const events: RuntimeEvent[] = []
        for await (const event of handle.events) events.push(event)
        const result = await handle.result
        expect(result.ok).toBe(true)
        expect(result.output).toBe('Hello')
        expect(events.some((event) => event.type === 'session')).toBe(true)
        expect(
            events.filter((event) => event.type === 'text_delta' && event.token).length,
        ).toBe(2)
        expect(events.some((event) => event.type === 'tool_call')).toBe(true)
        await runtime.dispose()
    })

    it('reuses one ACP session across turns', async () => {
        const runtime = new AcpRuntime(config())
        const first = await runtime.runTurn({ sessionId: 'reuse', prompt: 'one' })
        for await (const _event of first.events) void _event
        await first.result
        const second = await runtime.runTurn({ sessionId: 'reuse', prompt: 'two' })
        let reused = false
        for await (const event of second.events) {
            if (event.type === 'session' && event.reused) reused = true
        }
        await second.result
        expect(reused).toBe(true)
        await runtime.dispose()
    })
})

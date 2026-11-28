import { assert, run, readJson, workspace } from './npm-release.mjs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const archive = process.argv[2]
const dshCli = process.argv[3]
assert.ok(archive, 'Usage: node scripts/verify-npm.mjs <tarball> [path/to/dsh/lib/bin.js]')
const directory = mkdtempSync(join(tmpdir(), 'agentarts-npm-'))
const options = { cwd: directory }
const env = { ...process.env, DSH_HOME: join(directory, 'dsh'), DSH_AGENT_CWD: directory }
let server
let exited
try {
    writeFileSync(join(directory, 'package.json'), '{"private":true}\n')
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', resolve(archive)], options)
    const packageDir = join(directory, 'node_modules/@huaweicloud/agentarts-adapter-js')
    const manifest = readJson(join(packageDir, 'package.json'))
    assert.equal(manifest.version, readJson(join(workspace, 'npm/package.json')).version)
    assert.ok(existsSync(join(packageDir, 'LICENSE')))
    assert.ok(!existsSync(join(packageDir, '.agentarts_config.yaml')))
    const [bin, ...binArgs] = process.platform === 'win32'
        ? [process.execPath, join(packageDir, manifest.bin['agentarts-adapter'])]
        : [join(directory, 'node_modules/.bin/agentarts-adapter')]

    run(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict'
        import { createHarnessApp } from '@huaweicloud/agentarts-adapter-js'
        import { banner } from '@huaweicloud/agentarts-adapter-js/helper'
        import { checkNodeVersion } from '@huaweicloud/agentarts-adapter-js/precheck'
        assert.equal(typeof createHarnessApp, 'function')
        assert.match(banner(), /agentarts-harness-adapter/)
        assert.equal(checkNodeVersion().ok, true)
    `], options)
    run(bin, [...binArgs, 'prepare-profile'], { ...options, env })
    const profile = join(env.DSH_HOME, 'profiles/acp')
    const { dependencies } = readJson(join(profile, 'package.json'))
    const plugins = Object.entries(dependencies)
        .filter(([, version]) => version.startsWith('file:./vendor/'))
        .map(([name]) => name)
    assert.ok(plugins.length > 0)
    assert.ok(existsSync(join(profile, 'cordis.patch.yml')))
    assert.ok(existsSync(join(profile, 'cordis.yml')))
    run(process.execPath, ['--input-type=module', '-e', `
        for (const plugin of process.argv.slice(1)) await import(plugin)
    `, ...plugins], { cwd: profile })
    if (dshCli) {
        const rendered = run(process.execPath, [resolve(dshCli), '--profile', 'acp', '--dump-config'], {
            ...options, env, capture: true,
        })
        for (const name of plugins) {
            assert.ok(rendered.includes(name.split('/').at(-1)), `DSH did not resolve plugin ${name}`)
        }
        console.log('External DSH CLI resolved all profile plugins')
    }

    const listener = createServer().listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const { port } = listener.address()
    await new Promise(resolve => listener.close(resolve))
    server = spawn(bin, [...binArgs, 'start'], {
        ...options,
        env: {
            ...env,
            AGENT_RUNTIME_TYPE: 'DSH',
            AGENT_SERVER_HOST: '127.0.0.1',
            AGENT_SERVER_PORT: String(port),
            DSH_ACP_COMMAND: process.execPath,
            DSH_ACP_ARGS: `"${join(workspace, 'runtime/test/fixtures/fake-acp.mjs')}"`,
        },
        stdio: 'inherit',
    })
    exited = once(server, 'exit')
    void exited.catch(() => {})
    const url = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 90_000
    let ready = false
    while (!ready && Date.now() < deadline) {
        await Promise.race([
            fetch(`${url}/ping`, { signal: AbortSignal.timeout(1000) })
                .then(response => { ready = response.ok })
                .catch(() => {}),
            exited.then(([code, signal]) => { throw new Error(`Adapter exited: ${code ?? signal}`) }),
        ])
        if (!ready) await delay(150)
    }
    assert.ok(ready, 'Installed adapter did not become ready')
    const invocation = await fetch(`${url}/invocations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Hello from the installed tarball', stream: false }),
        signal: AbortSignal.timeout(10_000),
    })
    const body = await invocation.json()
    assert.ok(invocation.ok, JSON.stringify(body))
    assert.equal(body.output, 'Hello')
    console.log('Installed tarball, profile plugins and ACP invocation verified')
} finally {
    if (server && server.exitCode === null && server.signalCode === null) {
        server.kill()
        const timeout = setTimeout(() => server.kill('SIGKILL'), 3000)
        try { await exited.catch(() => {}) } finally { clearTimeout(timeout) }
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

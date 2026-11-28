import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export { assert }
export const workspace = fileURLToPath(new URL('../', import.meta.url))
export const dist = join(workspace, 'dist')

export function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'))
}

export function run(command, args, { capture = false, ...options } = {}) {
    if (command === 'npm' && process.platform === 'win32') {
        // Start npm directly so spaces in tarball and installation paths survive .cmd quoting.
        const shims = run('where.exe', ['npm.cmd'], { capture: true }).trim().split(/\r?\n/)
        const npmCli = shims.map(shim => join(dirname(shim), 'node_modules/npm/bin/npm-cli.js')).find(existsSync)
        assert.ok(npmCli, 'Could not locate npm-cli.js beside npm.cmd')
        command = process.execPath
        args = [npmCli, ...args]
    }
    const result = spawnSync(command, args, {
        ...options, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `${command} exited with ${result.status ?? result.signal}`)
    return result.stdout
}

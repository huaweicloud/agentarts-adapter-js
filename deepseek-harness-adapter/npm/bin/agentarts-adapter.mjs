#!/usr/bin/env node
import { resolve } from 'node:path'

const [command = 'start', ...args] = process.argv.slice(2)
if (args.length || !['start', 'prepare-profile', '--help', '-h'].includes(command)) {
    console.error('Usage: agentarts-adapter [start|prepare-profile|--help]')
    process.exitCode = 1
} else if (command === '--help' || command === '-h') {
    console.log('Usage: agentarts-adapter [start|prepare-profile|--help]')
} else {
    const { loadDotEnv } = await import('../runtime/dist/config.js')
    loadDotEnv(process.env.DSH_ENV_FILE)
    process.env.DSH_HOME = resolve(process.env.DSH_HOME || '.dsh')
    if (command === 'prepare-profile') {
        const { loadAdapterConfig } = await import('../adapter/dist/config.js')
        const { materializeProfile } = await import('../adapter/dist/patch.js')
        const { profileDir } = materializeProfile(loadAdapterConfig(), undefined, 'npm')
        console.log(`DSH profile: ${profileDir}`)
    } else {
        const { startAdapter } = await import('../adapter/dist/main.js')
        await startAdapter()
    }
}

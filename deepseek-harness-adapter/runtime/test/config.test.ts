import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
    loadConfig,
    SESSIONS_PATCH,
    SKILLS_PATCH,
    SYSTEM_PROMPT_PATCH,
    TOKEN_PATCH,
} from '../src/config.js'

function patchArgs(args: string[]): string[] {
    return args.flatMap((arg, index) => (arg === '--patch' ? [args[index + 1]] : []))
}

/** Read a `!!js` expression out of a patch file, without its YAML quoting. */
function readExpression(file: URL, pattern: RegExp): string {
    const patch = readFileSync(file, 'utf8')
    const expression = patch.match(pattern)?.[1]
    expect(expression, `${file.pathname} must carry a !!js expression`).toBeDefined()
    return expression as string
}

/** Evaluate a patch expression the way the DSH Loader does for `!!js` config. */
function evaluate(expression: string): unknown {
    const context = {
        dshHomePath: (...parts: string[]) => ['/dsh-home', ...parts].join('/'),
    }
    return new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')(context, expression)
}

const SESSIONS_FILE = new URL('../plugins/sessions-dir.patch.yml', import.meta.url)
const SKILLS_FILE = new URL('../plugins/skills-dir.patch.yml', import.meta.url)

describe('patch mount', () => {
    it('mounts token, system-prompt, skills and sessions patches by default', () => {
        const config = loadConfig({ DSH_ACP_TOKEN_STREAM: '1' })
        expect(patchArgs(config.acpArgs)).toEqual([
            TOKEN_PATCH,
            SYSTEM_PROMPT_PATCH,
            SKILLS_PATCH,
            SESSIONS_PATCH,
        ])
    })

    it('skips only the token patch when token streaming is disabled', () => {
        const config = loadConfig({ DSH_ACP_TOKEN_STREAM: '0' })
        expect(patchArgs(config.acpArgs)).toEqual([
            SYSTEM_PROMPT_PATCH,
            SKILLS_PATCH,
            SESSIONS_PATCH,
        ])
    })

    it('does not inject patches into explicit DSH_ACP_ARGS', () => {
        const config = loadConfig({ DSH_ACP_ARGS: '--profile custom --patch /tmp/custom.patch.yml' })
        expect(config.acpArgs).toEqual(['--profile', 'custom', '--patch', '/tmp/custom.patch.yml'])
    })
})

describe('session store mount', () => {
    it('targets the DSH session row and keeps the custom-dir precedence', () => {
        const patch = readFileSync(SESSIONS_FILE, 'utf8')
        expect(patch).toContain('id: session-persistence-jsonl')
        expect(patch).toContain('AGENTRUN_SESSIONS_DIR')
        expect(patch).toContain("process.env.AGENTRUN_DIR + '/sessions'")
        expect(patch).toContain("dshHomePath('sessions')")
    })

    it('evaluates to the configured mount, then AGENTRUN_DIR, then DSH home', () => {
        const expression = readExpression(SESSIONS_FILE, /root: !!js "(.*)"/)
        const previous = {
            sessions: process.env.AGENTRUN_SESSIONS_DIR,
            dir: process.env.AGENTRUN_DIR,
        }
        try {
            delete process.env.AGENTRUN_SESSIONS_DIR
            delete process.env.AGENTRUN_DIR
            expect(evaluate(expression)).toBe('/dsh-home/sessions')

            process.env.AGENTRUN_DIR = '/home/agentarts'
            expect(evaluate(expression)).toBe('/home/agentarts/sessions')

            process.env.AGENTRUN_SESSIONS_DIR = '/mnt/sessions'
            expect(evaluate(expression)).toBe('/mnt/sessions')
        } finally {
            if (previous.sessions === undefined) delete process.env.AGENTRUN_SESSIONS_DIR
            else process.env.AGENTRUN_SESSIONS_DIR = previous.sessions
            if (previous.dir === undefined) delete process.env.AGENTRUN_DIR
            else process.env.AGENTRUN_DIR = previous.dir
        }
    })
})

describe('skills mount', () => {
    it('targets the dsh-base skill row and restates the config a patch replaces', () => {
        const patch = readFileSync(SKILLS_FILE, 'utf8')
        expect(patch).toContain('id: skill-filesystem')
        expect(patch).toContain('customSkillDirs')
        expect(patch).toContain('includeDefaultRoots: true')
        expect(patch).toContain('watch: false')
        expect(patch).toContain('AGENTRUN_DIR')
    })

    it('evaluates to AGENTRUN_DIR/skills, falling back to /home/agentarts/skills', () => {
        const expression = readExpression(SKILLS_FILE, /-\s+!!js (.*)/)
        const previous = process.env.AGENTRUN_DIR
        try {
            delete process.env.AGENTRUN_DIR
            expect(evaluate(expression)).toBe('/home/agentarts/skills')

            process.env.AGENTRUN_DIR = '/opt/agent'
            expect(evaluate(expression)).toBe('/opt/agent/skills')
        } finally {
            if (previous === undefined) delete process.env.AGENTRUN_DIR
            else process.env.AGENTRUN_DIR = previous
        }
    })
})

describe('child environment', () => {
    it('forwards the mount directories the patches evaluate inside the child', () => {
        const config = loadConfig({
            AGENTRUN_DIR: '/mnt/data',
            AGENTRUN_SESSIONS_DIR: '/mnt/sessions',
            AGENTARTS_PROTOCOL_TOKEN: 'platform-only',
        })
        expect(config.acpEnv).toEqual({
            AGENTRUN_DIR: '/mnt/data',
            AGENTRUN_SESSIONS_DIR: '/mnt/sessions',
        })
    })
})

import { describe, expect, it } from 'vitest'
import { buildLaunchSpec } from '../src/launch-spec.js'
import { ENV_SESSION_ID, ENV_EVENT_ID, ENV_ATTEMPT, ENV_RECALL_RESULT } from
    '@agentarts/harness-dsh-shared'

describe('buildLaunchSpec', () => {
    it('命令与参数符合 spawn 契约', () => {
        const spec = buildLaunchSpec(
            { sessionId: 's', prompt: 'p', eventId: 'e', attempt: 1 }, '')
        expect(spec.command).toBe('dsh')
        expect(spec.args).toEqual(['--profile', 'agentrun', '-'])
        expect(spec.encodeStdin('任务')).toBe('任务')
    })

    it('轮次变量注入 env', () => {
        const spec = buildLaunchSpec(
            { sessionId: 's', prompt: 'p', eventId: 'e', attempt: 3 }, '召回')
        expect(spec.env[ENV_SESSION_ID]).toBe('s')
        expect(spec.env[ENV_EVENT_ID]).toBe('e')
        expect(spec.env[ENV_ATTEMPT]).toBe('3')
        expect(spec.env[ENV_RECALL_RESULT]).toBe('召回')
    })

    it('白名单过滤：名单外变量不进子进程', () => {
        process.env.SECRET_TOKEN = 'do-not-leak'
        process.env.DEEPSEEK_API_KEY = 'k'
        process.env.MCP_SEARCH_URL = 'http://mcp'
        const spec = buildLaunchSpec(
            { sessionId: 's', prompt: 'p', eventId: 'e', attempt: 1 }, '')
        expect(spec.env.SECRET_TOKEN).toBeUndefined()
        expect(spec.env.DEEPSEEK_API_KEY).toBe('k')
        expect(spec.env.MCP_SEARCH_URL).toBe('http://mcp')
        delete process.env.SECRET_TOKEN
    })

    it('MCP 凭证变量不进子进程，仅 MCP_*_URL 端点放行（BUG-02 回归）', () => {
        process.env.MCP_AUTH_TOKEN = 'secret'
        process.env.MCP_API_KEY = 'secret'
        process.env.MCP_SEARCH_URL = 'http://mcp'
        const spec = buildLaunchSpec(
            { sessionId: 's', prompt: 'p', eventId: 'e', attempt: 1 }, '')
        expect(spec.env.MCP_AUTH_TOKEN).toBeUndefined()
        expect(spec.env.MCP_API_KEY).toBeUndefined()
        expect(spec.env.MCP_SEARCH_URL).toBe('http://mcp')
        delete process.env.MCP_AUTH_TOKEN
        delete process.env.MCP_API_KEY
        delete process.env.MCP_SEARCH_URL
    })
})
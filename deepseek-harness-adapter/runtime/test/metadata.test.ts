import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('managed harness configuration', () => {
    it.each([
        ['{bad', 'DSH_ACP_CHILD_ENV is not valid JSON'],
        ['["not-an-object"]', 'DSH_ACP_CHILD_ENV must be a JSON object'],
    ])('reports an invalid ACP child environment override (%s)', (value, error) => {
        expect(() => loadConfig({ DSH_ACP_CHILD_ENV: value })).toThrow(error)
    })

    it('maps model and persona fields and keeps platform credentials out of the child', () => {
        const config = loadConfig({
            agent_metadata: JSON.stringify({ system_prompt: 'persona', model_config: { name: 'model',
                api_key: 'model-key', base_url: 'https://model.example' } }),
            AGENTARTS_PROTOCOL_TOKEN: 'platform-only', AGENTRUN_MAX_CONCURRENCY: '2x', PATH: 'bin',
        })
        expect(config.model).toBe('model')
        expect(config.systemPrompt?.text).toBe('persona')
        expect(config.acpEnv).toEqual({ PATH: 'bin', DEEPSEEK_API_KEY: 'model-key', DEEPSEEK_BASE_URL: 'https://model.example' })
        expect(config.maxConcurrency).toBe(15)
    })
})

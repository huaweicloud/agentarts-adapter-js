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

    it('passes the instrumentation same-name otel environment to the child', () => {
        const config = loadConfig({
            PATH: 'bin',
            agentarts_agentops_apm_token: 'apm-token',
            agentarts_agentops_apm_exporter_endpoint: 'https://apm.example',
            agentarts_agentops_aom_access_code: 'aom-code',
            agent_domain_id: 'domain-1',
            resource_type: 'agent',
            UNRELATED_SECRET: 'nope',
        })
        expect(config.acpEnv['agentarts_agentops_apm_token']).toBe('apm-token')
        expect(config.acpEnv['agentarts_agentops_apm_exporter_endpoint']).toBe('https://apm.example')
        expect(config.acpEnv['agentarts_agentops_aom_access_code']).toBe('aom-code')
        expect(config.acpEnv['agent_domain_id']).toBe('domain-1')
        expect(config.acpEnv['resource_type']).toBe('agent')
        expect(config.acpEnv['UNRELATED_SECRET']).toBeUndefined()
    })

    it('accepts the UPPER_CASE adapter names and injects the plugin lower-case keys', () => {
        const config = loadConfig({
            PATH: 'bin',
            AGENTARTS_AGENTOPS_APM_TOKEN: 'apm-token',
            AGENT_DOMAIN_ID: 'domain-1',
            RESOURCE_TYPE: 'agent',
        })
        expect(config.acpEnv['agentarts_agentops_apm_token']).toBe('apm-token')
        expect(config.acpEnv['agent_domain_id']).toBe('domain-1')
        expect(config.acpEnv['resource_type']).toBe('agent')
        expect(config.acpEnv['AGENTARTS_AGENTOPS_APM_TOKEN']).toBeUndefined()
    })
})

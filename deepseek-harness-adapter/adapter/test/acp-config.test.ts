import { expect, it, vi } from 'vitest'
import { loadHostedDshConfig } from '../src/acp-config.js'

it('loads wrapped #14 metadata with scoped credentials and both deployment MCP gateways', async () => {
    const env = {
        AGENTARTS_PROTOCOL_TOKEN: 'parent-only',
        DSH_SYSTEM_PROMPT: 'explicit persona',
        DSH_ACP_CHILD_ENV: '{"EXTRA_CHILD_ENV":"explicit"}',
        agent_metadata: JSON.stringify({
            agent_metadata: {
                system_prompt: 'metadata persona',
                model_config: { name: 'shared-model', credential_provider_name: 'model-provider', base_url: 'https://model.example' },
                memory_config: { id: 'memory-space', memory_user_id: 'actor', credential_provider_name: 'memory-provider' },
                mcp_config: [
                    { id: 'first', endpoint: 'https://first.example/mcp', credential_provider_name: 'mcp-provider' },
                    { id: 'second', endpoint: 'https://second.example/mcp' },
                ],
                skills: 'sample:Skill:1',
                user_bucket: 'skill-bucket',
            },
        }),
    }
    const resolveApiKey = vi.fn(async (provider: string) => provider + '-key')
    const config = await loadHostedDshConfig(env, { resolveApiKey })

    expect(config.model).toBe('shared-model')
    expect(config.modelProvider).toBeUndefined()
    expect(config.systemPrompt?.text).toBe('explicit persona')
    expect(config.acpEnv).toMatchObject({
        MODEL_API_KEY: 'model-provider-key',
        AGENTARTS_MEMORY_SPACE_ID: 'memory-space',
        AGENTARTS_MEMORY_USER_ID: 'actor',
        HUAWEICLOUD_SDK_MEMORY_API_KEY: 'memory-provider-key',
        EXTRA_CHILD_ENV: 'explicit',
    })
    expect(config.acpEnv.AGENTARTS_PROTOCOL_TOKEN).toBeUndefined()
    expect(JSON.parse(config.acpEnv.agent_metadata)).toEqual({ skills: 'sample:Skill:1', user_bucket: 'skill-bucket' })
    expect(config.deployedMcpServers).toEqual([
        { name: 'first', type: 'http', url: 'https://first.example/mcp',
            headers: [{ name: 'Authorization', value: 'Bearer mcp-provider-key' }] },
        { name: 'second', type: 'http', url: 'https://second.example/mcp', headers: [] },
    ])
})

it('keeps explicit model selection and refuses tool policies ACP cannot enforce', async () => {
    const provider = { resolveApiKey: vi.fn() }
    const config = await loadHostedDshConfig({
        DSH_ACP_MODEL: 'explicit-model',
        agent_metadata: '{"model_config":{"name":"deployment-model"}}',
    }, provider)
    expect(config.model).toBe('explicit-model')
    expect(config.modelProvider).toBeUndefined()
    expect(provider.resolveApiKey).not.toHaveBeenCalled()
    await expect(loadHostedDshConfig({ agent_metadata: '{"allowed_tools":["read"]}' }, provider))
        .rejects.toThrow('requires a supported DSH tool policy')
})

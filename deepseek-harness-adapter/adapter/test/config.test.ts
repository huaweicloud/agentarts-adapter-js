import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadAdapterConfig } from '../src/config.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'agentarts-config-'));
  cleanup.push(path);
  return path;
}

describe('loadAdapterConfig', () => {
  it('merges file < AGENT_METADATA < direct env < argv and maps MCP auth', () => {
    const cwd = tempDir();
    const file = join(cwd, 'metadata.yaml');
    writeFileSync(
      file,
      `
agent_metadata:
  system_prompt: from-file
  allowed_tools: [read]
  skills: /mnt/skills
  model_config:
    name: file-model
    base_url: https://file.example
    api_key: file-key
  mcp_config:
    - id: gateway-id
      endpoint: https://mcp.example/mcp
      protocol_type: mcp
      protocol_configuration:
        mcp:
          search_configuration:
            search_type: ""
          supported_versions:
            - 2025-03-26
          session_configuration:
            enabled: false
      auth_type: api_key
      identity_urn: agentIdentity:cn-southwest-2:workloadIdentity:default/gateway-fo2ao8pg
      credential_provider_name: gateway-fo2ao8pg
      auth_location: header
      auth_param_name: Authorization
`,
    );
    const config = loadAdapterConfig({
      cwd,
      env: {
        agent_metadata:
          '{"agent_metadata":{"model_config":{"name":"env-model","base_url":"https://env.example"}}}',
        DEEPSEEK_API_KEY: 'env-key',
      },
      argv: {
        configFile: file,
        dshHome: join(cwd, 'custom-home'),
        set: ['agent_metadata.model_config.name=argv-model'],
      },
    });
    expect(config.model).toEqual({
      provider: 'agentarts-model',
      name: 'argv-model',
      protocol: 'openai-completions',
      baseUrl: 'https://env.example/v1',
      apiKey: 'env-key',
    });
    expect(config.systemPrompt).toBe('from-file');
    expect(config.allowedTools).toEqual(['read']);
    expect(config.skills).toBe('/mnt/skills');
    expect(config.mcps).toEqual([
      {
        id: 'gateway-id',
        serverName: 'gateway-id',
        endpoint: 'https://mcp.example/mcp',
        protocol: 'streamable-http',
        headers: {},
        authParamName: 'Authorization',
        credentialProviderName: 'gateway-fo2ao8pg',
        identityUrn: 'agentIdentity:cn-southwest-2:workloadIdentity:default/gateway-fo2ao8pg',
      },
    ]);
    expect(config.dsh.dshHome).toBe(join(cwd, 'custom-home'));
  });

  it('accepts the lower-case agent_metadata env without the agent_metadata wrapper', () => {
    const config = loadAdapterConfig({
      env: {
        agent_metadata: JSON.stringify({
          system_prompt: 'unwrapped',
          allowed_tools: null,
          model_config: { name: 'glm-5.1', credential_provider_name: 'model-provider' },
          mcp_config: [{ id: 'g1', endpoint: 'https://mcp.example/mcp', protocol_type: 'mcp' }],
        }),
      },
    });
    expect(config.systemPrompt).toBe('unwrapped');
    expect(config.model).toMatchObject({
      name: 'glm-5.1',
      credentialProviderName: 'model-provider',
    });
    expect(config.mcps).toHaveLength(1);
  });

  it('supports the upper-case input alias and executable overlays', () => {
    const cwd = tempDir();
    const config = loadAdapterConfig({
      cwd,
      env: {
        AGENT_METADATA: JSON.stringify({
          system_prompt: 'from-env',
          allowed_tools: ['read', 'write', 'read'],
          skills: '/mounted/skills',
          model_config: { name: 'env-model' },
        }),
        AGENTRUN_DSH_COMMAND: 'node',
        AGENTRUN_DSH_ARGS: '["apps/cli/lib/bin.js"]',
        AGENTRUN_DSH_PATCHES: '["./mock.patch.yml"]',
        DSH_HOME: './home',
      },
    });
    expect(config.systemPrompt).toBe('from-env');
    expect(config.allowedTools).toEqual(['read', 'write']);
    expect(config.skills).toBe('/mounted/skills');
    expect(config.model.name).toBe('env-model');
    expect(config.dsh.command).toBe('node');
    expect(config.dsh.args).toEqual(['apps/cli/lib/bin.js']);
    expect(config.dsh.patches).toEqual([join(cwd, 'mock.patch.yml')]);
  });

  it.each(['SSE', 'stdio'])('rejects unsupported MCP protocol_type %s', (protocolType) => {
    expect(() =>
      loadAdapterConfig({
        env: {
          AGENT_METADATA: JSON.stringify({
            agent_metadata: {
              mcp_config: [
                { id: 'x', endpoint: 'https://example.com', protocol_type: protocolType },
              ],
            },
          }),
        },
      }),
    ).toThrow(/only mcp is supported/);
  });

  it.each([
    ['openai', 'openai-completions', 'https://model.example/v1'],
    ['anthropic', 'anthropic-messages', 'https://model.example'],
    ['MASS', 'openai-completions', 'https://model.example/v1'],
    [undefined, 'openai-completions', 'https://model.example/v1'],
  ])('resolves protocol and base_url root for MODEL_PROVIDER=%s', (provider, protocol, expected) => {
    const config = loadAdapterConfig({
      env: {
        ...(provider === undefined ? {} : { MODEL_PROVIDER: provider }),
        AGENT_METADATA: JSON.stringify({
          agent_metadata: { model_config: { name: 'm', base_url: 'https://model.example' } },
        }),
      },
    });
    expect(config.model.baseUrl).toBe(expected);
    expect(config.model.protocol).toBe(protocol);
  });

  it('rejects malformed config and unsafe --set paths', () => {
    expect(() => loadAdapterConfig({ env: { AGENT_METADATA: '[]' } })).toThrow(
      /expected an object/,
    );
    expect(() => loadAdapterConfig({ argv: { set: ['__proto__.polluted=true'] } })).toThrow(
      /unsafe/,
    );
    expect(() => loadAdapterConfig({ env: { AGENTRUN_DSH_TIMEOUT_MS: '0' } })).toThrow(
      /positive integer/,
    );
  });
});

import { describe, expect, it } from 'vitest';

import { loadAdapterConfig } from '../src/config.js';
import {
  resolveCredentials,
  resolveRegion,
  SdkCredentialProvider,
  StaticCredentialProvider,
  type CredentialProvider,
} from '../src/credential.js';

class FakeProvider implements CredentialProvider {
  readonly calls: string[] = [];

  constructor(private readonly prefix = 'key-for-') {}

  async resolveApiKey(providerName: string): Promise<string> {
    this.calls.push(providerName);
    return `${this.prefix}${providerName}`;
  }
}

function configWith(metadata: Record<string, unknown>) {
  return loadAdapterConfig({
    env: {},
    argv: { metadata: JSON.stringify({ agent_metadata: metadata }) },
  });
}

describe('resolveCredentials', () => {
  it('resolves model and MCP api keys from credential_provider_name', async () => {
    const config = configWith({
      model_config: { name: 'm', credential_provider_name: 'model-provider' },
      mcp_config: [
        {
          id: 'gw',
          endpoint: 'https://mcp.example/mcp',
          protocol_type: 'mcp',
          credential_provider_name: 'mcp-provider',
        },
      ],
    });
    const provider = new FakeProvider();
    const credentials = await resolveCredentials(config, provider, new AbortController().signal);
    expect(credentials.modelApiKey).toBe('key-for-model-provider');
    expect(credentials.mcpHeaders['gw']).toEqual({ Authorization: 'Bearer key-for-mcp-provider' });
    expect(provider.calls).toEqual(['model-provider', 'mcp-provider']);
  });

  it('keeps inline api keys and only resolves the missing gateway header', async () => {
    const config = configWith({
      model_config: { name: 'm', api_key: 'inline-model-key' },
      mcp_config: [
        {
          id: 'gw',
          endpoint: 'https://mcp.example/mcp',
          protocol_type: 'mcp',
          credential_provider_name: 'mcp-provider',
        },
      ],
    });
    const provider = new FakeProvider();
    const credentials = await resolveCredentials(config, provider, new AbortController().signal);
    expect(credentials.modelApiKey).toBe('inline-model-key');
    expect(credentials.mcpHeaders['gw']).toEqual({ Authorization: 'Bearer key-for-mcp-provider' });
    expect(provider.calls).toEqual(['mcp-provider']);
  });

  it('resolves no provider calls when everything is inline or absent', async () => {
    const config = configWith({
      model_config: { name: 'm', api_key: 'inline' },
    });
    const provider = new FakeProvider();
    const credentials = await resolveCredentials(config, provider, new AbortController().signal);
    expect(credentials.modelApiKey).toBe('inline');
    expect(credentials.mcpHeaders).toEqual({});
    expect(provider.calls).toEqual([]);
  });
});

describe('providers', () => {
  it('StaticCredentialProvider reads AGENTRUN_CREDENTIAL_<NAME>', async () => {
    const provider = new StaticCredentialProvider({
      AGENTRUN_CREDENTIAL_MY_PROVIDER: 'static-key',
    });
    await expect(provider.resolveApiKey('my-provider')).resolves.toBe('static-key');
  });

  it('SdkCredentialProvider loads the SDK lazily only when resolving a key', async () => {
    let loaded = false;
    const loadSdk = async () => {
      loaded = true;
      throw new Error('unexpected load');
    };
    const provider = new SdkCredentialProvider('cn-southwest-2', loadSdk);
    expect(loaded).toBe(false);
  });

  it('resolveRegion follows env chain with cn-southwest-2 default', () => {
    expect(resolveRegion({})).toBe('cn-southwest-2');
    expect(resolveRegion({ HUAWEICLOUD_REGION: 'cn-north-4' })).toBe('cn-north-4');
    expect(
      resolveRegion({ HUAWEICLOUD_SDK_REGION: 'ap-southeast-4', HUAWEICLOUD_REGION: 'cn-north-4' }),
    ).toBe('ap-southeast-4');
  });
});

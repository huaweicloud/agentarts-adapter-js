import { describe, expect, it, vi } from 'vitest';

import { loadAdapterConfig } from '../src/config.js';
import { SdkRecallProvider } from '../src/recall.js';
import type { InvocationRequest } from '../src/types.js';

function fakeSdk() {
  const search = vi.fn(async (_spaceId: string, _filters: unknown) => ({
    results: [{ record: { content: 'recalled memory' }, score: 0.91 }],
  }));
  class MemoryClient {
    constructor(readonly options: Record<string, unknown>) {}
    searchMemories(spaceId: string, filters: unknown) {
      return search(spaceId, filters);
    }
    close() {
      return Promise.resolve();
    }
  }
  class MemorySearchFilter {
    constructor(readonly init: Record<string, unknown>) {}
  }
  return { MemoryClient, MemorySearchFilter, search };
}

function configWithMemory(memoryConfig: Record<string, unknown>) {
  return loadAdapterConfig({
    env: {},
    argv: { metadata: JSON.stringify({ agent_metadata: { memory_config: memoryConfig } }) },
  });
}

const invocation: InvocationRequest = { prompt: 'what did I say?', eventId: 'e', attempt: 1 };

describe('SdkRecallProvider', () => {
  it('returns empty recall without loading the SDK when no memory space is configured', async () => {
    const config = loadAdapterConfig({ env: {}, argv: {} });
    let loaded = false;
    const loadSdk = async () => {
      loaded = true;
      throw new Error('unexpected load');
    };
    const provider = new SdkRecallProvider('cn-southwest-2', loadSdk);
    await expect(
      provider.recall({ config, invocation, signal: new AbortController().signal }),
    ).resolves.toEqual({ memory: [], knowledgeBases: [] });
    expect(loaded).toBe(false);
  });

  it('calls SDK MemoryClient.searchMemories with the prompt, space id and preferred endpoint', async () => {
    const config = configWithMemory({
      id: 'space-1',
      api_key: 'memory-key',
      private_access: { domain_name: 'memory.internal', ip: '' },
      public_access: { domain_name: 'memory.public', ip: '' },
    });
    const sdk = fakeSdk();
    const loadSdk = async () => sdk;
    const provider = new SdkRecallProvider('cn-southwest-2', loadSdk);
    const result = await provider.recall({
      config,
      invocation,
      signal: new AbortController().signal,
    });
    expect(sdk.search).toHaveBeenCalledTimes(1);
    const [spaceId, filter] = sdk.search.mock.calls[0] as [string, { init: Record<string, unknown> }];
    expect(spaceId).toBe('space-1');
    expect(filter.init).toMatchObject({ query: 'what did I say?', topK: 10, minScore: 0.5 });
    expect(process.env['AGENTARTS_MEMORY_DATA_ENDPOINT']).toBe('memory.internal');
    expect(result.memory).toEqual([{ record: { content: 'recalled memory' }, score: 0.91 }]);
    expect(result.knowledgeBases).toEqual([]);
  });
});

describe('memory endpoint extraction', () => {
  it('prefers private_access.domain_name and falls back to public_access', () => {
    const withPrivate = configWithMemory({
      id: 's',
      private_access: { domain_name: 'memory.internal' },
      public_access: { domain_name: 'memory.public' },
    });
    expect(withPrivate.memory?.endpoint).toBe('memory.internal');

    const publicOnly = configWithMemory({
      id: 's',
      public_access: { domain_name: 'memory.public' },
    });
    expect(publicOnly.memory?.endpoint).toBe('memory.public');
  });
});

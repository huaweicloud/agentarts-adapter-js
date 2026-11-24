import { ADAPTER_ENV } from '@agentarts/shared';
import { parse } from 'yaml';

import { resolveRegion } from './credential.js';
import type { AdapterConfig, InvocationRequest, RecallBundle } from './types.js';
import { EMPTY_RECALL } from './types.js';

/** Recall request supplied to the SDK-backed provider. */
export interface RecallInput {
  readonly config: AdapterConfig;
  readonly invocation: InvocationRequest;
  readonly signal: AbortSignal;
}

/** Replaceable memory/knowledge recall seam; credentials stay in the Adapter process. */
export interface RecallProvider {
  recall(input: RecallInput): Promise<RecallBundle>;
}

/** Minimal surface adapter relies on from @huaweicloud/agentarts-sdk memory client. */
interface SdkMemorySurface {
  MemoryClient: new (options: {
    regionName?: string;
    apiKey?: string;
    verifySsl?: boolean | string;
  }) => {
    searchMemories(spaceId: string, filters: unknown): Promise<{ results: readonly unknown[] }>;
    close(): Promise<void>;
  };
  MemorySearchFilter: new (init: Record<string, unknown>) => unknown;
}

/** MemoryClient and MemorySearchFilter are exported from the sdk/memory subpath, not the package root. */
const SDK_SPECIFIER = '@huaweicloud/agentarts-sdk/sdk/memory';

/** SDK reads the data-plane endpoint from this env (or the region default) when MemoryClient is constructed. */
const MEMORY_DATA_ENDPOINT_ENV = 'AGENTARTS_MEMORY_DATA_ENDPOINT';

/** Runtime-only module loader, opaque to bundlers so the optional SDK is never statically resolved. */
const loadModule = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

/**
 * Default memory recall backed by @huaweicloud/agentarts-sdk MemoryClient.searchMemories.
 * MemoryClient resolves its data-plane endpoint from AGENTARTS_MEMORY_DATA_ENDPOINT,
 * so the endpoint extracted by config (private access preferred over public) is exported
 * into that variable before the client is constructed.
 */
export class SdkRecallProvider implements RecallProvider {
  private sdkPromise?: Promise<SdkMemorySurface>;

  constructor(
    private readonly region: string = resolveRegion(),
    private readonly loadSdk: (specifier: string) => Promise<unknown> = loadModule,
  ) {}

  async recall(input: RecallInput): Promise<RecallBundle> {
    const memory = input.config.memory;
    if (memory?.spaceId === undefined) return { memory: [], knowledgeBases: [] };

    this.sdkPromise ??= this.loadSdk(SDK_SPECIFIER) as Promise<SdkMemorySurface>;
    const sdk = await this.sdkPromise;
    if (memory.endpoint !== undefined) {
      process.env[MEMORY_DATA_ENDPOINT_ENV] = memory.endpoint;
    }
    const client = new sdk.MemoryClient({
      regionName: this.region,
      ...(memory.apiKey ? { apiKey: memory.apiKey } : {}),
    });
    try {
      const result = await client.searchMemories(
        memory.spaceId,
        new sdk.MemorySearchFilter({
          query: input.invocation.prompt,
          topK: 10,
          minScore: 0.5,
        }),
      );
      return { memory: result.results ?? [], knowledgeBases: [] };
    } finally {
      await client.close();
    }
  }
}

function parseArray(
  text: string | undefined,
  key: string,
  wrappers: readonly string[],
): readonly unknown[] {
  if (!text) return [];
  const value: unknown = parse(text, { logLevel: 'silent' });
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null) {
    for (const wrapper of wrappers) {
      const wrapped = (value as Record<string, unknown>)[wrapper];
      if (Array.isArray(wrapped)) return wrapped;
    }
  }
  throw new Error(`${key}: expected an array or an object containing ${wrappers.join('/')}`);
}

/** Demo provider that treats already-recalled env JSON as the retrieval result. */
export class StaticRecallProvider implements RecallProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async recall(_input: RecallInput): Promise<RecallBundle> {
    return {
      memory: parseArray(this.env[ADAPTER_ENV.memoryRecallInput], ADAPTER_ENV.memoryRecallInput, [
        'memory',
        'memories',
      ]),
      knowledgeBases: parseArray(
        this.env[ADAPTER_ENV.knowledgeRecallInput],
        ADAPTER_ENV.knowledgeRecallInput,
        ['knowledgeBases', 'knowledges', 'results'],
      ),
    };
  }
}

/** Run retrieval with the architecture's 300ms budget; timeout and retrieval failure degrade to empty recall. */
export async function recallWithFallback(
  provider: RecallProvider,
  input: Omit<RecallInput, 'signal'>,
  onWarning: (message: string) => void = () => undefined,
  timeoutMs = 300,
): Promise<RecallBundle> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`recall timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([provider.recall({ ...input, signal: controller.signal }), timeout]);
  } catch (error) {
    onWarning(
      `recall degraded to empty: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { memory: [...EMPTY_RECALL.memory], knowledgeBases: [...EMPTY_RECALL.knowledgeBases] };
  } finally {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  }
}

import type { AdapterConfig } from './types.js';

/** Minimal surface adapter relies on from @huaweicloud/agentarts-sdk identity (package root). */
interface SdkIdentitySurface {
  IdentityClient: new (
    region: string,
    ignoreSsl?: boolean | null,
  ) => {
    getResourceApiKey(options: {
      providerName: string;
      workloadAccessToken: string;
    }): Promise<string>;
  };
}

/** getWorkloadAccessToken is exported from the sdk/identity subpath, not the package root. */
interface SdkIdentityAuthSurface {
  getWorkloadAccessToken(client: unknown): Promise<string>;
}

const SDK_SPECIFIER = '@huaweicloud/agentarts-sdk';
const SDK_IDENTITY_SUBSPECIFIER = '@huaweicloud/agentarts-sdk/sdk/identity';

/** Runtime-only module loader, opaque to bundlers so the optional SDK is never statically resolved. */
const loadModule = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

/** Resolves a credential-provider name to its API key. */
export interface CredentialProvider {
  resolveApiKey(providerName: string, signal: AbortSignal): Promise<string>;
}

/** API keys and headers resolved from the platform credential service. */
export interface ResolvedCredentials {
  readonly modelApiKey?: string;
  readonly memoryApiKey?: string;
  readonly mcpHeaders: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Resolve region like the SDK's getRegion(): env chain with cn-southwest-2 default. */
export function resolveRegion(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env['HUAWEICLOUD_SDK_REGION'] ??
    env['HUAWEICLOUD_REGION'] ??
    env['OS_REGION_NAME'] ??
    'cn-southwest-2'
  );
}

/** Default provider backed by @huaweicloud/agentarts-sdk; SDK is loaded lazily only when a key is needed. */
export class SdkCredentialProvider implements CredentialProvider {
  private sdkPromise?: Promise<SdkIdentitySurface>;

  constructor(
    private readonly region: string,
    private readonly loadSdk: (specifier: string) => Promise<unknown> = loadModule,
  ) {}

  static fromRegion(region = resolveRegion()): SdkCredentialProvider {
    return new SdkCredentialProvider(region);
  }

  async resolveApiKey(providerName: string): Promise<string> {
    this.sdkPromise ??= this.loadSdk(SDK_SPECIFIER) as Promise<SdkIdentitySurface>;
    const sdk = await this.sdkPromise;
    // The published package exposes IdentityClient at its root but getWorkloadAccessToken
    // only from the identity subpath; load the subpath explicitly instead of assuming the root.
    const auth = (await this.loadSdk(SDK_IDENTITY_SUBSPECIFIER)) as SdkIdentityAuthSurface;
    const client = new sdk.IdentityClient(this.region, null);
    const workloadAccessToken = await auth.getWorkloadAccessToken(client);
    return client.getResourceApiKey({ providerName, workloadAccessToken });
  }
}

/** Demo/test provider reading resolved keys from environment: AGENTRUN_CREDENTIAL_<NAME>. */
export class StaticCredentialProvider implements CredentialProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolveApiKey(providerName: string): Promise<string> {
    const normalized = providerName.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
    const key = this.env[`AGENTRUN_CREDENTIAL_${normalized}`];
    if (!key) throw new Error(`static credential provider has no key for ${providerName}`);
    return key;
  }
}

function modelProviderName(config: AdapterConfig): string | undefined {
  return config.model.credentialProviderName;
}

/**
 * Resolve the API keys the child process needs, only when the platform did not
 * already supply them inline. Model and each MCP gateway resolve independently.
 */
export async function resolveCredentials(
  config: AdapterConfig,
  provider: CredentialProvider,
  signal: AbortSignal,
): Promise<ResolvedCredentials> {
  let modelApiKey = config.model.apiKey;
  const modelProvider = modelProviderName(config);
  if (modelApiKey === undefined && modelProvider !== undefined) {
    modelApiKey = await provider.resolveApiKey(modelProvider, signal);
  }

  let memoryApiKey = config.memory?.apiKey;
  if (memoryApiKey === undefined && config.memory?.credentialProviderName !== undefined) {
    memoryApiKey = await provider.resolveApiKey(config.memory.credentialProviderName, signal);
  }

  const mcpHeaders: Record<string, Readonly<Record<string, string>>> = {};
  for (const mcp of config.mcps) {
    const headers = { ...mcp.headers };
    if (Object.keys(headers).length === 0 && mcp.credentialProviderName !== undefined) {
      const apiKey = await provider.resolveApiKey(mcp.credentialProviderName, signal);
      headers[mcp.authParamName] = `Bearer ${apiKey}`;
    }
    mcpHeaders[mcp.serverName] = headers;
  }
  return {
    ...(modelApiKey === undefined ? {} : { modelApiKey }),
    ...(memoryApiKey === undefined ? {} : { memoryApiKey }),
    mcpHeaders,
  };
}

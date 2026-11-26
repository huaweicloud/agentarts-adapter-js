import { buildChildEnv, loadAdapterConfig } from './config.js';
import { resolveCredentials, SdkCredentialProvider } from './credential.js';
import type { AdapterConfig } from './types.js';
import type { ResolvedCredentials } from './credential.js';

/**
 * Translate the parsed agent_metadata (AdapterConfig) into the ACP runtime's
 * environment contract, so runtime/loadConfig() picks it up unchanged.
 *
 * - model name / system prompt → DSH_ACP_MODEL / DSH_SYSTEM_PROMPT
 * - everything the DSH child needs (memory, skills, credentials, MCP headers)
 *   is serialized into DSH_ACP_CHILD_ENV (the AcpClient merges it over process.env)
 * - the first MCP gateway → DSH_AGENTARTS_GATEWAY_* (resolved by runtime's GatewayResolver)
 */
export function applyAgentMetadataToAcpEnv(
  config: AdapterConfig,
  env: NodeJS.ProcessEnv = process.env,
  credentials?: ResolvedCredentials,
): void {
  if (config.model.name !== '') env['DSH_ACP_MODEL'] = config.model.name;
  if (config.systemPrompt !== '') env['DSH_SYSTEM_PROMPT'] = config.systemPrompt;

  // Reuse the Adapter's child-env builder (memory/skills/OBS credentials/agent_metadata/...).
  // credentials carries the model/memory API keys resolved via the identity service.
  env['DSH_ACP_CHILD_ENV'] = JSON.stringify(buildChildEnv(config, env, credentials));

  const [firstMcp] = config.mcps;
  if (firstMcp !== undefined) {
    env['DSH_AGENTARTS_GATEWAY_MCP_URL'] = firstMcp.endpoint;
    env['DSH_AGENTARTS_GATEWAY_SERVER_NAME'] = firstMcp.serverName;
    const headers = credentials?.mcpHeaders[firstMcp.serverName] ?? firstMcp.headers;
    const authorization = headers['Authorization'] ?? headers['authorization'];
    if (authorization !== undefined) {
      env['DSH_AGENTARTS_GATEWAY_API_KEY'] = authorization.replace(/^Bearer\s+/i, '');
    }
  }
}

/** Parse agent_metadata, resolve credentials via the identity service, then apply ACP env. */
export async function bootstrapAcpFromAgentMetadata(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadAdapterConfig({ env });
  const credentials = await resolveCredentials(
    config,
    SdkCredentialProvider.fromRegion(),
    AbortSignal.timeout(config.dsh.timeoutMs),
  );
  applyAgentMetadataToAcpEnv(config, env, credentials);
}

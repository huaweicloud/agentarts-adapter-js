import { buildChildEnv, loadAdapterConfig } from './config.js';
import type { AdapterConfig } from './types.js';

/**
 * Translate the parsed agent_metadata (AdapterConfig) into the ACP runtime's
 * environment contract, so runtime/loadConfig() picks it up unchanged.
 *
 * - model name / system prompt → DSH_ACP_MODEL / DSH_SYSTEM_PROMPT
 * - everything the DSH child needs (memory, skills, credentials, MCP headers)
 *   is serialized into DSH_ACP_CHILD_ENV (the AcpClient merges it over process.env)
 * - the first MCP gateway → DSH_AGENTARTS_GATEWAY_* (resolved by runtime's GatewayResolver)
 */
export function applyAgentMetadataToAcpEnv(config: AdapterConfig, env: NodeJS.ProcessEnv = process.env): void {
  if (config.model.name !== '') env['DSH_ACP_MODEL'] = config.model.name;
  if (config.systemPrompt !== '') env['DSH_SYSTEM_PROMPT'] = config.systemPrompt;

  // Reuse the Adapter's child-env builder (memory/skills/OBS credentials/agent_metadata/...).
  env['DSH_ACP_CHILD_ENV'] = JSON.stringify(buildChildEnv(config, env));

  const [firstMcp] = config.mcps;
  if (firstMcp !== undefined) {
    env['DSH_AGENTARTS_GATEWAY_MCP_URL'] = firstMcp.endpoint;
    env['DSH_AGENTARTS_GATEWAY_SERVER_NAME'] = firstMcp.serverName;
    const authorization = firstMcp.headers['Authorization'] ?? firstMcp.headers['authorization'];
    if (authorization !== undefined) {
      env['DSH_AGENTARTS_GATEWAY_API_KEY'] = authorization.replace(/^Bearer\s+/i, '');
    }
  }
}

/** Parse agent_metadata and apply it to process.env before runtime/loadConfig() runs. */
export function bootstrapAcpFromAgentMetadata(env: NodeJS.ProcessEnv = process.env): void {
  applyAgentMetadataToAcpEnv(loadAdapterConfig({ env }), env);
}

/** AGENTRUN_* 环境变量名：Adapter 与子进程之间的自有契约。 */
export const ENV_SESSION_ID = 'AGENTRUN_DSH_SESSION_ID'
export const ENV_EVENT_ID = 'AGENTRUN_EVENT_ID'
export const ENV_ATTEMPT = 'AGENTRUN_ATTEMPT'
export const ENV_SYSTEM_PROMPT = 'AGENTRUN_SYSTEM_PROMPT'
export const ENV_RECALL_RESULT = 'AGENTRUN_RECALL_RESULT'

/** Exact document-defined environment key carrying the complete agent_metadata JSON object. */
export const AGENT_METADATA_ENV = 'agent_metadata';

/** Upper-case compatibility alias accepted as Adapter input; child injection uses agent_metadata. */
export const AGENT_METADATA_ALIAS_ENV = 'AGENT_METADATA';

/** Operational keys and invocation data that are outside the agent_metadata configuration object. */
export const ADAPTER_ENV = {
  configFile: 'AGENTRUN_CONFIG_FILE',
  dshCommand: 'AGENTRUN_DSH_COMMAND',
  dshArgs: 'AGENTRUN_DSH_ARGS',
  dshPatches: 'AGENTRUN_DSH_PATCHES',
  dshCwd: 'AGENTRUN_DSH_CWD',
  dshTimeoutMs: 'AGENTRUN_DSH_TIMEOUT_MS',
  sessionId: 'AGENTRUN_DSH_SESSION_ID',
  eventId: 'AGENTRUN_DSH_EVENT_ID',
  attempt: 'AGENTRUN_DSH_ATTEMPT',
  dataLakeEndpoint: 'AGENTRUN_DATALAKE_ENDPOINT',
  dataLakeApiKey: 'AGENTRUN_DATALAKE_API_KEY',
} as const;

/** Standard model environment consumed by DSH's DeepSeek provider. */
export const MODEL_ENV = {
  apiKey: 'DEEPSEEK_API_KEY',
  baseUrl: 'DEEPSEEK_BASE_URL',
} as const;

/** Model provider protocol name: openai, maas or anthropic; determines the pi-ai wire protocol and base_url root. */
export const MODEL_PROVIDER_ENV = 'MODEL_PROVIDER';

/** Environment key the rendered dsh-llm-pi-ai route reads for the model API key. */
export const MODEL_API_KEY_ENV = 'MODEL_API_KEY';

/** Process basics explicitly allowed by the architecture's child-environment whitelist. */
export const BASE_CHILD_ENV = ['DSH_HOME', 'PATH', 'HOME', 'NODE_ENV', 'TZ', 'LANG'] as const;

/** DataLake values are consumed inside the DSH process and therefore cross the spawn boundary. */
export const DATALAKE_CHILD_ENV_PATTERN = /^AGENTRUN_DATALAKE_[A-Z0-9_]+$/;

/** Per-upstream MCP endpoint convention named by the architecture. */
export const MCP_URL_ENV_PATTERN = /^MCP_[A-Z0-9_]+_URL$/;

/**
 * AgentArts observation env contract for agentarts-instrumentation-dsh, named after the repo's
 * UPPER_CASE convention. The plugin itself reads its same-name otel keys in lower case from
 * `process.env` (its KNOWN_OTEL_KEYS contract), so the DSH child receives the lower-case
 * canonical names; both casings are accepted at the adapter boundary (see
 * `readInstrumentationChildEnv`).
 */
export const INSTRUMENTATION_ENV = [
  'AGENTARTS_AGENTOPS_OTEL_AGENT_APM_ENABLE',
  'AGENTARTS_AGENTOPS_OTEL_AGENT_AOM_ENABLE',
  'AGENTARTS_AGENTOPS_APM_TOKEN',
  'AGENTARTS_AGENTOPS_APM_EXPORTER_ENDPOINT',
  'AGENTARTS_AGENTOPS_AOM_ACCESS_CODE',
  'AGENTARTS_AGENTOPS_AOM_EXPORTER_ENDPOINT',
  'AGENTARTS_AGENTOPS_AOM_PROMETHEUS_ID',
  'AGENT_DOMAIN_ID',
  'AGENTARTS_PROJECT_ID',
  'AGENT_RESOURCE_ID',
  'RESOURCE_TYPE',
] as const;

/**
 * Read the child-facing instrumentation variables from a parent environment and normalize them
 * to the plugin's canonical lower-case key names. Both the adapter's UPPER_CASE names and the
 * plugin's lower-case names are accepted; on case-sensitive systems only the exact spelling is
 * visible, so both lookups are needed. The UPPER_CASE spelling wins when both are set.
 */
export function readInstrumentationChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of INSTRUMENTATION_ENV) {
    const value = env[key] ?? env[key.toLowerCase()];
    if (value !== undefined) result[key.toLowerCase()] = value;
  }
  return result;
}

/** Keys whose values must not be printed by demos and diagnostics. */
export const SENSITIVE_ENV_PATTERN = /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|ACCESS_CODE)/i;

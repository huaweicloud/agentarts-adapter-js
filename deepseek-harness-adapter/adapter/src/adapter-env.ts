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

/** Keys whose values must not be printed by demos and diagnostics. */
export const SENSITIVE_ENV_PATTERN = /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i;

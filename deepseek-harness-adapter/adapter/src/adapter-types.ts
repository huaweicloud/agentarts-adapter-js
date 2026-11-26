/** JSON/YAML object used at external configuration and process boundaries. */
export type UnknownRecord = Record<string, unknown>;

/** One MCP gateway. Its transport is always streamable-http; the API key is resolved later. */
export interface McpUpstream {
  readonly id: string;
  readonly serverName: string;
  readonly endpoint: string;
  readonly protocol: 'streamable-http';
  readonly headers: Readonly<Record<string, string>>;
  readonly credentialProviderName?: string;
  readonly identityUrn?: string;
  /** Authorization header name; defaults to `Authorization`. */
  readonly authParamName: string;
}

/** Wire protocol handed to dsh-llm-pi-ai's provider route. */
export type ModelProtocol = 'openai-completions' | 'anthropic-messages';

/** Normalized model settings rendered into agent-default-model and the dsh-llm-pi-ai route. */
export interface ModelSettings {
  /** Provider route id registered under dsh-llm-pi-ai. */
  readonly provider: 'agentarts-model';
  readonly name: string;
  /** Protocol root handed to pi-ai (openai: origin + /v1, anthropic: origin). */
  readonly baseUrl?: string;
  /** Wire protocol resolved from MODEL_PROVIDER. */
  readonly protocol: ModelProtocol;
  /** Inline API key (demo only); production resolves it from credentialProviderName. */
  readonly apiKey?: string;
  /** Credential provider name used by the platform to resolve the real API key. */
  readonly credentialProviderName?: string;
}

/** Memory service settings extracted from agent_metadata.memory_config. */
export interface MemorySettings {
  readonly spaceId: string;
  /** Endpoint preferred from private_access.domain_name, falling back to public_access.domain_name. */
  readonly endpoint?: string;
  readonly apiKey?: string;
  /** Credential provider used when the platform does not inline the memory API key. */
  readonly credentialProviderName?: string;
  /** Strategy id required by backends that reject direct writes without one. */
  readonly strategyId?: string;
}

/** DSH executable resolution, separate from agent_metadata so images can use their own launcher. */
export interface DshSettings {
  readonly command: string;
  readonly args: readonly string[];
  readonly patches: readonly string[];
  readonly cwd: string;
  readonly dshHome: string;
  readonly profile: string;
  readonly timeoutMs: number;
}

/** Fully merged and validated Adapter configuration. */
export interface AdapterConfig {
  readonly metadata: UnknownRecord;
  readonly model: ModelSettings;
  readonly systemPrompt: string;
  readonly allowedTools: readonly string[] | null;
  readonly skills?: string;
  readonly mcps: readonly McpUpstream[];
  readonly memory?: MemorySettings;
  readonly dsh: DshSettings;
}

/** One platform invocation. A fresh official headless run may omit sessionId. */
export interface InvocationRequest {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly eventId: string;
  readonly attempt: number;
}

/** Recall bundle carried in the invocation envelope. Retrieval happens in the DSH process (dsh-agentarts-memory); the Adapter always supplies an empty bundle. */
export interface RecallBundle {
  readonly memory: readonly unknown[];
  readonly knowledgeBases: readonly unknown[];
}

/** One-round input envelope written to the child stdin. */
export interface InvocationEnvelope {
  readonly sessionId?: string;
  readonly eventId: string;
  readonly attempt: number;
  readonly prompt: string;
  readonly recall: RecallBundle;
}

export const EMPTY_RECALL: RecallBundle = { memory: [], knowledgeBases: [] };

/** One parsed stdout frame. The SDK owns the public frame contract; Adapter only forwards records. */
export interface AdapterFrame extends UnknownRecord {
  readonly type?: string;
}

/** Result of the generic one-shot child runner. */
export interface ChildRunResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly frames: readonly AdapterFrame[];
  readonly final?: AdapterFrame;
  readonly stderr: string;
  readonly error?: string;
  readonly durationMs: number;
}

/** One row from DSH --dump-config. JS expressions remain unevaluated strings. */
export interface PluginEntry extends UnknownRecord {
  readonly id?: string;
  readonly name?: string;
  readonly disabled?: unknown;
  readonly config?: unknown;
}

/** Expected row properties checked by ops reconcile. */
export interface ExpectedPluginRow {
  readonly id: string;
  readonly disabled?: boolean;
  readonly config?: unknown;
}

/** Rendered profile plus the actual composed rows reported by DSH. */
export interface ProfileSnapshot {
  readonly capturedAt: string;
  readonly profileDir: string;
  readonly renderedPatch: string;
  readonly entries: readonly PluginEntry[];
  readonly dump: string;
}

/** Difference between expected rows and the DSH-composed tree. */
export interface ReconcileReport {
  readonly ok: boolean;
  readonly missingRows: readonly string[];
  readonly disabledMismatches: readonly string[];
  readonly configMismatches: readonly string[];
  readonly warnings: readonly string[];
}

/** Options accepted from argv, which outrank environment and mounted files. */
export interface ConfigArgvOverrides {
  readonly configFile?: string;
  readonly metadata?: string;
  readonly set?: readonly string[];
  readonly dshCommand?: string;
  readonly dshArgs?: readonly string[];
  readonly dshPatches?: readonly string[];
  readonly dshCwd?: string;
  readonly dshHome?: string;
  readonly timeoutMs?: number;
}

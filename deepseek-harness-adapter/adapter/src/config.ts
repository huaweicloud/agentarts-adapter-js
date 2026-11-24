import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  ADAPTER_ENV,
  AGENT_METADATA_ALIAS_ENV,
  AGENT_METADATA_ENV,
  BASE_CHILD_ENV,
  DATALAKE_CHILD_ENV_PATTERN,
  MCP_URL_ENV_PATTERN,
  MODEL_API_KEY_ENV,
  MODEL_ENV,
  MODEL_PROVIDER_ENV,
  SENSITIVE_ENV_PATTERN,
} from '@agentarts/shared';
import { parse } from 'yaml';

import type {
  AdapterConfig,
  ConfigArgvOverrides,
  McpUpstream,
  MemorySettings,
  ModelProtocol,
  UnknownRecord,
} from './types.js';
import type { ResolvedCredentials } from './credential.js';

/** Inputs to configuration resolution. */
export interface LoadConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly argv?: ConfigArgvOverrides;
}

const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_TIMEOUT_MS = 300_000;
const FORBIDDEN_SET_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, source: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${source}: expected an object`);
  return value;
}

function parseDocument(text: string, source: string): UnknownRecord {
  let value: unknown;
  try {
    value = parse(text, { logLevel: 'silent' });
  } catch (error) {
    throw new Error(`${source}: invalid JSON/YAML: ${String(error)}`);
  }
  const record = requireRecord(value, source);
  if (record['agent_metadata'] === undefined) return { agent_metadata: record };
  requireRecord(record['agent_metadata'], `${source}.agent_metadata`);
  return record;
}

function merge(base: UnknownRecord, overlay: UnknownRecord): UnknownRecord {
  const result: UnknownRecord = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const previous = result[key];
    result[key] = isRecord(previous) && isRecord(value) ? merge(previous, value) : value;
  }
  return result;
}

function setPath(root: UnknownRecord, expression: string): void {
  const separator = expression.indexOf('=');
  if (separator <= 0)
    throw new Error(`--set expects path=value, got ${JSON.stringify(expression)}`);
  const path = expression.slice(0, separator).split('.');
  if (path.some((part) => part.length === 0 || FORBIDDEN_SET_KEYS.has(part))) {
    throw new Error(`--set contains an unsafe or empty path: ${JSON.stringify(expression)}`);
  }
  const rawValue = expression.slice(separator + 1);
  const value: unknown = parse(rawValue, { logLevel: 'silent' });
  let cursor = root;
  for (const part of path.slice(0, -1)) {
    const next = cursor[part];
    if (next !== undefined && !isRecord(next))
      throw new Error(`--set cannot traverse scalar path segment ${part}`);
    cursor = cursor[part] = isRecord(next) ? next : {};
  }
  cursor[path[path.length - 1]!] = value;
}

function optionalString(record: UnknownRecord, key: string, source: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${source}.${key}: expected a string`);
  return value;
}

/** Resolve MODEL_PROVIDER (openai|maas|anthropic) into the pi-ai wire protocol. */
function resolveModelProtocol(provider: string | undefined): ModelProtocol {
  return provider?.toLowerCase() === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
}

/**
 * Translate a bare platform base_url into the protocol root pi-ai expects.
 * openai/maas route through openai-completions, whose baseURL is handed to the
 * OpenAI SDK (origin + /v1); anthropic routes through anthropic-messages, whose
 * baseURL is handed to the Anthropic SDK (bare origin, it appends /v1/messages).
 */
function resolveModelBaseUrl(baseUrl: string, protocol: ModelProtocol): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (protocol === 'anthropic-messages') return normalized;
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

function directEnvironmentLayer(env: NodeJS.ProcessEnv): UnknownRecord {
  const modelConfig: UnknownRecord = {};
  if (env[MODEL_ENV.baseUrl]) modelConfig['base_url'] = env[MODEL_ENV.baseUrl];
  if (env[MODEL_ENV.apiKey]) modelConfig['api_key'] = env[MODEL_ENV.apiKey];
  return {
    agent_metadata: Object.keys(modelConfig).length > 0 ? { model_config: modelConfig } : {},
  };
}

function normalizeAllowedTools(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    throw new Error('agent_metadata.allowed_tools: expected null or an array of non-empty strings');
  }
  return [...new Set(value as string[])];
}

function normalizeServerName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
  if (normalized.length === 0)
    throw new Error(`MCP id ${JSON.stringify(value)} has no usable serverName characters`);
  return normalized;
}

function normalizeHeaders(raw: UnknownRecord, source: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const existing = raw['headers'];
  if (existing !== undefined) {
    for (const [name, value] of Object.entries(requireRecord(existing, `${source}.headers`))) {
      if (typeof value !== 'string')
        throw new Error(`${source}.headers.${name}: expected a string`);
      headers[name] = value;
    }
  }
  const apiKey = optionalString(raw, 'api_key', source);
  const authType = optionalString(raw, 'auth_type', source);
  const authLocation = optionalString(raw, 'auth_location', source);
  if (authType !== undefined && authType !== 'api_key') {
    throw new Error(`${source}.auth_type: only api_key is supported, got ${authType}`);
  }
  if (authLocation !== undefined && authLocation !== 'header') {
    throw new Error(`${source}.auth_location: only header is supported, got ${authLocation}`);
  }
  if (apiKey !== undefined) {
    const name = optionalString(raw, 'auth_param_name', source) ?? 'Authorization';
    // 网关要求 Authorization: Bearer <key>；已带前缀则原样，否则自动补上。
    headers[name] = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
  }
  return headers;
}

function normalizeMcpGateway(metadata: UnknownRecord): readonly McpUpstream[] {
  const raw = metadata['mcp_config'];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('agent_metadata.mcp_config: expected an array');
  const names = new Set<string>();
  return raw.map((item, index) => {
    const source = `agent_metadata.mcp_config[${index}]`;
    const gateway = requireRecord(item, source);
    const id = optionalString(gateway, 'id', source);
    if (!id) throw new Error(`${source}.id: required`);
    const endpoint =
      optionalString(gateway, 'endpoint', source) ?? optionalString(gateway, 'url', source);
    if (!endpoint) throw new Error(`${source}.endpoint: required`);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(endpoint);
    } catch {
      throw new Error(`${source}.endpoint: expected an absolute HTTP(S) URL`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`${source}.endpoint: only HTTP(S) is supported`);
    }
    const protocolType = optionalString(gateway, 'protocol_type', source);
    if (protocolType !== undefined && protocolType !== 'mcp') {
      throw new Error(`${source}.protocol_type: only mcp is supported, got ${protocolType}`);
    }
    const serverName = normalizeServerName(optionalString(gateway, 'serverName', source) ?? id);
    if (names.has(serverName))
      throw new Error(`${source}.id: duplicate MCP serverName ${serverName}`);
    names.add(serverName);
    const credentialProviderName = optionalString(gateway, 'credential_provider_name', source);
    const identityUrn = optionalString(gateway, 'identity_urn', source);
    const authParamName = optionalString(gateway, 'auth_param_name', source) ?? 'Authorization';
    return {
      id,
      serverName,
      endpoint,
      protocol: 'streamable-http',
      headers: normalizeHeaders(gateway, source),
      authParamName,
      ...(credentialProviderName ? { credentialProviderName } : {}),
      ...(identityUrn ? { identityUrn } : {}),
    } as const;
  });
}

/** Extract memory space id and its endpoint, preferring private access over public. */
function normalizeMemory(metadata: UnknownRecord): MemorySettings | undefined {
  const raw = metadata['memory_config'];
  if (raw === undefined || raw === null) return undefined;
  const memory = requireRecord(raw, 'agent_metadata.memory_config');
  const spaceId = optionalString(memory, 'id', 'agent_metadata.memory_config');
  if (!spaceId) return undefined;
  const apiKey = optionalString(memory, 'api_key', 'agent_metadata.memory_config');
  const privateAccess = isRecord(memory['private_access']) ? memory['private_access'] : {};
  const publicAccess = isRecord(memory['public_access']) ? memory['public_access'] : {};
  const endpoint =
    optionalString(privateAccess, 'domain_name', 'agent_metadata.memory_config.private_access') ??
    optionalString(publicAccess, 'domain_name', 'agent_metadata.memory_config.public_access');
  return {
    spaceId,
    ...(endpoint ? { endpoint } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

function parseStringArray(value: string | undefined, key: string): readonly string[] {
  if (!value) return [];
  const parsed: unknown = parse(value, { logLevel: 'silent' });
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${key}: expected a JSON/YAML array of strings`);
  }
  return parsed as string[];
}

function timeoutFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${ADAPTER_ENV.dshTimeoutMs}: expected a positive integer`);
  return parsed;
}

function absoluteFrom(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

/** Resolve argv > environment > mounted file > defaults and validate the result. */
export function loadAdapterConfig(options: LoadConfigOptions = {}): AdapterConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const argv = options.argv ?? {};
  let document: UnknownRecord = { agent_metadata: {} };

  const configFile = argv.configFile ?? env[ADAPTER_ENV.configFile];
  if (configFile) {
    const path = absoluteFrom(cwd, configFile);
    document = merge(document, parseDocument(readFileSync(path, 'utf8'), path));
  }
  const environmentMetadata = env[AGENT_METADATA_ENV] ?? env[AGENT_METADATA_ALIAS_ENV];
  if (environmentMetadata)
    document = merge(document, parseDocument(environmentMetadata, AGENT_METADATA_ENV));
  document = merge(document, directEnvironmentLayer(env));
  if (argv.metadata) document = merge(document, parseDocument(argv.metadata, '--metadata'));
  for (const expression of argv.set ?? []) setPath(document, expression);

  const metadata = requireRecord(document['agent_metadata'], 'agent_metadata');
  const modelConfig = isRecord(metadata['model_config']) ? metadata['model_config'] : {};
  const modelName =
    optionalString(modelConfig, 'name', 'agent_metadata.model_config') ?? DEFAULT_MODEL;
  const rawBaseUrl = optionalString(modelConfig, 'base_url', 'agent_metadata.model_config');
  const protocol = resolveModelProtocol(env[MODEL_PROVIDER_ENV]);
  const baseUrl =
    rawBaseUrl === undefined ? undefined : resolveModelBaseUrl(rawBaseUrl, protocol);
  const apiKey = optionalString(modelConfig, 'api_key', 'agent_metadata.model_config');
  const credentialProviderName = optionalString(
    modelConfig,
    'credential_provider_name',
    'agent_metadata.model_config',
  );
  const systemPrompt = metadata['system_prompt'] ?? '';
  if (typeof systemPrompt !== 'string')
    throw new Error('agent_metadata.system_prompt: expected a string');
  const skills = optionalString(metadata, 'skills', 'agent_metadata');
  const dshHome = absoluteFrom(
    cwd,
    argv.dshHome ?? env['DSH_HOME'] ?? resolve(tmpdir(), 'agentarts-dsh-demo-home'),
  );
  const dshCwd = absoluteFrom(cwd, argv.dshCwd ?? env[ADAPTER_ENV.dshCwd] ?? cwd);
  const timeoutMs =
    argv.timeoutMs ?? timeoutFromEnv(env[ADAPTER_ENV.dshTimeoutMs]) ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('timeoutMs: expected a positive integer');

  return {
    metadata,
    model: {
      provider: 'agentarts-model',
      name: modelName,
      protocol,
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(credentialProviderName ? { credentialProviderName } : {}),
    },
    systemPrompt,
    allowedTools: normalizeAllowedTools(metadata['allowed_tools']),
    ...(skills ? { skills } : {}),
    mcps: normalizeMcpGateway(metadata),
    memory: normalizeMemory(metadata),
    dsh: {
      command: argv.dshCommand ?? env[ADAPTER_ENV.dshCommand] ?? 'dsh',
      args: argv.dshArgs ?? parseStringArray(env[ADAPTER_ENV.dshArgs], ADAPTER_ENV.dshArgs),
      patches: (
        argv.dshPatches ?? parseStringArray(env[ADAPTER_ENV.dshPatches], ADAPTER_ENV.dshPatches)
      ).map((path) => absoluteFrom(cwd, path)),
      cwd: dshCwd,
      dshHome,
      profile: 'agentrun',
      timeoutMs,
    },
  };
}

function mcpUrlKey(serverName: string): string {
  return `MCP_${serverName.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_URL`;
}

/** Per-upstream secret header JSON consumed by the rendered !!js patch expression. */
export function mcpHeadersEnvName(serverName: string): string {
  return `AGENTRUN_DSH_MCP_${serverName.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_HEADERS`;
}

/** Build a fresh whitelist environment for one invocation; Adapter secrets are never inherited wholesale. */
export function buildChildEnv(
  config: AdapterConfig,
  parentEnv: NodeJS.ProcessEnv = process.env,
  credentials?: ResolvedCredentials,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_CHILD_ENV) {
    const value = parentEnv[key];
    if (value !== undefined) env[key] = value;
  }
  if (process.platform === 'win32') {
    // Windows process creation and shell discovery need a small OS-specific baseline.
    for (const key of ['SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
      const actualKey = Object.keys(parentEnv).find(
        (candidate) => candidate.toLowerCase() === key.toLowerCase(),
      );
      if (actualKey !== undefined && parentEnv[actualKey] !== undefined)
        env[actualKey] = parentEnv[actualKey];
    }
  }
  for (const [key, value] of Object.entries(parentEnv)) {
    if (
      value !== undefined &&
      (DATALAKE_CHILD_ENV_PATTERN.test(key) || MCP_URL_ENV_PATTERN.test(key))
    ) {
      env[key] = value;
    }
  }

  env['DSH_HOME'] = config.dsh.dshHome;
  env['DSH_AGENTS_HOME'] = parentEnv['DSH_AGENTS_HOME'] ?? join(config.dsh.dshHome, 'agents-home');
  env['DSH_TELEMETRY_DISABLED'] = parentEnv['DSH_TELEMETRY_DISABLED'] ?? '1';
  const modelApiKey = credentials?.modelApiKey ?? config.model.apiKey;
  // pi-ai reads its route key from MODEL_API_KEY; DEEPSEEK_* stays for the legacy provider.
  if (modelApiKey !== undefined) {
    env[MODEL_API_KEY_ENV] = modelApiKey;
    env[MODEL_ENV.apiKey] = modelApiKey;
  }
  if (config.model.baseUrl !== undefined) env[MODEL_ENV.baseUrl] = config.model.baseUrl;
  for (const mcp of config.mcps) {
    env[mcpUrlKey(mcp.serverName)] = mcp.endpoint;
    const headers = credentials?.mcpHeaders[mcp.serverName] ?? mcp.headers;
    env[mcpHeadersEnvName(mcp.serverName)] = JSON.stringify(headers);
  }
  return env;
}

function sensitiveKey(key: string): boolean {
  return (
    SENSITIVE_ENV_PATTERN.test(key) ||
    /(?:api_key|apiKey|password|secret|token|credential|headers)/i.test(key)
  );
}

/** Redact known credential fields recursively without hiding non-secret configuration. */
export function redactUnknown(value: unknown, key = ''): unknown {
  if (sensitiveKey(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => {
        if (
          childKey === 'headers' &&
          typeof child === 'object' &&
          child !== null &&
          !Array.isArray(child)
        ) {
          return [
            childKey,
            Object.fromEntries(Object.keys(child).map((name) => [name, '<redacted>'])),
          ];
        }
        return [childKey, redactUnknown(child, childKey)];
      }),
    );
  }
  return value;
}

/** Produce a printable env view. agent_metadata is parsed so nested credentials are also redacted. */
export function redactEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      if (sensitiveKey(key)) return [key, '<redacted>'];
      if (key === AGENT_METADATA_ENV || key === AGENT_METADATA_ALIAS_ENV) {
        try {
          return [key, JSON.stringify(redactUnknown(JSON.parse(value)))];
        } catch {
          return [key, '<redacted>'];
        }
      }
      return [key, value];
    }),
  );
}

/** Select the non-secret diagnostics that explain an invocation without dumping the entire metadata object. */
export function configDiagnostics(config: AdapterConfig): UnknownRecord {
  return {
    model: {
      provider: config.model.provider,
      name: config.model.name,
      protocol: config.model.protocol,
      baseUrl: config.model.baseUrl,
      apiKey: config.model.apiKey === undefined ? '<missing>' : '<redacted>',
    },
    systemPrompt: config.systemPrompt,
    allowedTools: config.allowedTools,
    skills: config.skills,
    mcps: redactUnknown(config.mcps),
    dsh: { ...config.dsh, args: [...config.dsh.args] },
  };
}

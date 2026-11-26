import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { buildChildEnv, loadAdapterConfig, redactEnv } from '../src/config.js';
import { materializeProfile } from '../src/patch.js';
import type { InvocationRequest } from '../src/types.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'agentarts-injection-'));
  cleanup.push(cwd);
  const config = loadAdapterConfig({
    cwd,
    env: {},
    argv: {
      dshHome: join(cwd, 'home'),
      metadata: JSON.stringify({
        agent_metadata: {
          system_prompt: 'deployment prompt',
          allowed_tools: ['read'],
          skills: '/mounted/skills',
          model_config: {
            name: 'test-model',
            base_url: 'https://model.example',
            api_key: 'model-secret',
          },
          mcp_config: [
            {
              id: 'gateway-id',
              endpoint: 'https://mcp.example/mcp',
              protocol_type: 'mcp',
              protocol_configuration: {
                mcp: {
                  search_configuration: { search_type: '' },
                  supported_versions: ['2025-03-26'],
                  session_configuration: { enabled: false },
                },
              },
              auth_type: 'api_key',
              identity_urn:
                'agentIdentity:cn-southwest-2:workloadIdentity:default/gateway-fo2ao8pg',
              credential_provider_name: 'gateway-fo2ao8pg',
              auth_location: 'header',
              auth_param_name: 'Authorization',
            },
          ],
          memory_config: {
            memory_external_provider: 'officeace_cloud',
            office_ace_deployment: 'cloud',
            memory_engine: 'both',
            memory_user_id: '',
            id: 'memory-id',
            api_key: 'memory-secret',
            strategy_id: 'strategy-test',
            auth_type: 'api_key',
            private_access: { domain_name: 'memory.internal', ip: '192.168.255.197' },
            public_access: { domain_name: 'memory.public', ip: '10.83.98.144' },
          },
        },
      }),
    },
  });
  const invocation: InvocationRequest = {
    prompt: 'task text',
    sessionId: 'session-1',
    eventId: 'event-1',
    attempt: 2,
  };
  const recall = {
    memory: [{ role: 'user', content: 'remember' }],
    knowledgeBases: [{ name: 'kb', results: [{ text: 'fact' }] }],
  };
  return { cwd, config, invocation, recall };
}

describe('child env injection', () => {
  it('uses a whitelist, injects agent_metadata and OBS credentials, and keeps configured model, MCP and memory values', () => {
    const { config } = fixture();
    const env = buildChildEnv(config, {
      PATH: '/bin',
      HOME: '/home/test',
      AGENT_METADATA: '{"secret":"do-not-copy"}',
      AGENTRUN_CONFIG_FILE: '/secret/config',
      AGENTRUN_MEMORY_RECALL: '["do-not-copy-input"]',
      MEMORY_API_KEY: 'do-not-copy',
      AGENTRUN_DATALAKE_ENDPOINT: 'https://datalake.example',
      AGENTRUN_DATALAKE_API_KEY: 'datalake-secret',
      MCP_OTHER_URL: 'https://other.example',
      HUAWEICLOUD_SDK_AK: 'obs-ak',
      HUAWEICLOUD_SDK_SK: 'obs-sk',
      HUAWEICLOUD_SDK_SECURITY_TOKEN: 'obs-sts',
      AGENTRUN_DIR: '/home/agentarts',
    });
    expect(env['PATH']).toBe('/bin');
    // Upper-case alias stays out; the document-defined lower-case object is injected for dsh-skill-obs.
    expect(env['AGENT_METADATA']).toBeUndefined();
    expect(env['agent_metadata']).toBe(JSON.stringify(config.metadata));
    expect(env['AGENTRUN_CONFIG_FILE']).toBeUndefined();
    expect(env['AGENTRUN_MEMORY_RECALL']).toBeUndefined();
    expect(env['MEMORY_API_KEY']).toBeUndefined();
    expect(env['HUAWEICLOUD_SDK_AK']).toBe('obs-ak');
    expect(env['HUAWEICLOUD_SDK_SK']).toBe('obs-sk');
    expect(env['HUAWEICLOUD_SDK_SECURITY_TOKEN']).toBe('obs-sts');
    expect(env['AGENTRUN_DIR']).toBe('/home/agentarts');
    expect(env['DEEPSEEK_API_KEY']).toBe('model-secret');
    expect(env['MODEL_API_KEY']).toBe('model-secret');
    expect(env['HUAWEICLOUD_SDK_MEMORY_API_KEY']).toBe('memory-secret');
    expect(env['AGENTARTS_MEMORY_SPACE_ID']).toBe('memory-id');
    expect(env['AGENTARTS_MEMORY_DATA_ENDPOINT']).toBe('memory.internal');
    expect(env['HUAWEICLOUD_SDK_REGION']).toBe('cn-southwest-2');
    expect(env['DEEPSEEK_BASE_URL']).toBe('https://model.example/v1');
    expect(env['AGENTRUN_DSH_SESSION_ID']).toBeUndefined();
    expect(env['AGENTRUN_DSH_EVENT_ID']).toBeUndefined();
    expect(env['AGENTRUN_DSH_ATTEMPT']).toBeUndefined();
    expect(env['MCP_GATEWAY_ID_URL']).toBe('https://mcp.example/mcp');
    expect(env['AGENTRUN_DSH_MCP_GATEWAY_ID_HEADERS']).toBe('{}');
    expect(env['AGENTRUN_DATALAKE_ENDPOINT']).toBe('https://datalake.example');
    expect(env['DSH_TELEMETRY_DISABLED']).toBe('1');
    expect(redactEnv(env)['DEEPSEEK_API_KEY']).toBe('<redacted>');
    expect(redactEnv(env)['HUAWEICLOUD_SDK_MEMORY_API_KEY']).toBe('<redacted>');
    expect(redactEnv(env)['AGENTRUN_DSH_MCP_GATEWAY_ID_HEADERS']).toBe('<redacted>');
  });
  it('keeps memory configuration and credentials out when memory_config is absent', () => {
    const config = loadAdapterConfig({
      env: {},
      argv: { metadata: '{"agent_metadata":{"model_config":{"name":"m","api_key":"inline"}}}' },
    });
    const env = buildChildEnv(config, {
      HUAWEICLOUD_SDK_MEMORY_API_KEY: 'must-not-leak',
      AGENTARTS_MEMORY_SPACE_ID: 'must-not-leak',
      AGENTARTS_MEMORY_DATA_ENDPOINT: 'must-not-leak',
    });
    expect(env['HUAWEICLOUD_SDK_MEMORY_API_KEY']).toBeUndefined();
    expect(env['AGENTARTS_MEMORY_SPACE_ID']).toBeUndefined();
    expect(env['AGENTARTS_MEMORY_DATA_ENDPOINT']).toBeUndefined();
  });
});

describe('profile rendering', () => {
  it('materializes base+headless+memory+skill-obs, keeps official runner/local stores and never writes secrets', () => {
    const { config } = fixture();
    const rendered = materializeProfile(config);
    const manifest = JSON.parse(readFileSync(join(rendered.profileDir, 'package.json'), 'utf8'));
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-headless',
      '@agentarts/dsh-agentarts-memory',
      '@agentarts/dsh-skill-obs',
    ]);
    expect(manifest.dependencies['@agentarts/dsh-agentarts-memory']).toBe(
      'file:./vendor/dsh-agentarts-memory',
    );
    expect(manifest.dependencies['@agentarts/dsh-skill-obs']).toBe('file:./vendor/dsh-skill-obs');
    expect(
      existsSync(
        join(rendered.profileDir, 'node_modules', '@agentarts', 'dsh-agentarts-memory', 'index.js'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(rendered.profileDir, 'node_modules', '@agentarts', 'dsh-skill-obs', 'index.js'),
      ),
    ).toBe(true);
    expect(
      existsSync(join(rendered.profileDir, 'vendor', 'dsh-skill-obs', 'cordis.patch.yml')),
    ).toBe(true);
    const memoryPatch = readFileSync(
      join(rendered.profileDir, 'vendor', 'dsh-agentarts-memory', 'cordis.patch.yml'),
      'utf8',
    );
    expect(memoryPatch).toContain('id: dsh-agentarts-memory');
    expect(memoryPatch).toContain("name: '@agentarts/dsh-agentarts-memory'");
    expect(memoryPatch).toContain('mode: tool');
    expect(memoryPatch).not.toContain('memory-secret');
    expect(readFileSync(join(rendered.profileDir, 'cordis.yml'), 'utf8')).toContain('[]');
    expect(rendered.renderedPatch).not.toContain('model-secret');
    expect(rendered.renderedPatch).not.toContain('mcp-secret');
    expect(rendered.renderedPatch).not.toContain('memory-secret');
    expect(rendered.renderedPatch).not.toContain('id: headless-runner');
    expect(rendered.renderedPatch).toContain('provider: "agentarts-model"');
    expect(rendered.renderedPatch).toContain('model: "test-model"');
    expect(rendered.renderedPatch).toContain('api: openai-completions');
    expect(rendered.renderedPatch).toContain('headers: !!js JSON.parse');
    expect(rendered.expected).toContainEqual({ id: 'dsh-agentarts-memory', disabled: false });
    const rows = parse(rendered.renderedPatch, {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => `!!js ${value}` }],
    }) as Array<Record<string, unknown>>;
    expect(rows.find((row) => row['id'] === 'agent-default-model')).toBeDefined();
    expect(rows.filter((row) => row['disabled'] === true).map((row) => row['id'])).toEqual([
      'ptc-runtime',
      'workflow-ptc',
      'tool-workflow',
    ]);
    const inserted = rows.find((row) => Array.isArray(row['insert']))?.['insert'] as Array<
      Record<string, unknown>
    >;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.['name']).toBe('@deepseek-ai/dsh-mcp-client');
  });
});

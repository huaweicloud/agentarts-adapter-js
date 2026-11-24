import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stringify } from 'yaml';

import { MODEL_API_KEY_ENV } from '@agentarts/shared';

import { mcpHeadersEnvName } from './config.js';
import type { AdapterConfig, ExpectedPluginRow, UnknownRecord } from './types.js';

/** Profile files rendered before DSH starts. */
export interface RenderedProfile {
  readonly profileDir: string;
  readonly renderedPatch: string;
  readonly expected: readonly ExpectedPluginRow[];
}

function yamlRows(rows: readonly UnknownRecord[]): string {
  return rows.length === 0 ? '' : stringify(rows).trimEnd();
}

function mcpHeaderExpression(mcp: AdapterConfig['mcps'][number]): string {
  return `!!js JSON.parse(process.env.${mcpHeadersEnvName(mcp.serverName)} || '{}')`;
}

function mcpRows(config: AdapterConfig): UnknownRecord[] {
  return config.mcps.map((mcp) => ({
    id: `agentrun-mcp-${mcp.serverName}`,
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      transport: 'streamable-http',
      serverName: mcp.serverName,
      url: mcp.endpoint,
      headers: `__AGENTRUN_MCP_HEADERS_${mcp.serverName}__`,
      toolCallTimeoutMs: 30_000,
      closeTimeoutMs: 5_000,
      expandTemplates: false,
      failOnStartupError: true,
      toolLoading: 'eager',
      catalogDescriptionMaxLength: 160,
    },
  }));
}

/** Route the model through dsh-llm-pi-ai's generic provider, keyed by config.model.provider. */
function modelProviderRows(config: AdapterConfig): UnknownRecord[] {
  return [
    {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: {
        providers: {
          [config.model.provider]: {
            apiKeyEnv: MODEL_API_KEY_ENV,
            api: config.model.protocol,
            ...(config.model.baseUrl === undefined ? {} : { baseURL: config.model.baseUrl }),
            models: [{ id: config.model.name, name: config.model.name }],
          },
        },
      },
    },
  ];
}

/** Render only configuration rows; the official runner and local persistence stay mounted in this milestone. */
export function renderPatch(
  config: AdapterConfig,
  template: string,
): { patch: string; expected: readonly ExpectedPluginRow[] } {
  const expected: ExpectedPluginRow[] = [
    { id: 'headless-runner', disabled: false },
    { id: 'ptc-runtime', disabled: true },
    { id: 'workflow-ptc', disabled: true },
    { id: 'tool-workflow', disabled: true },
    { id: 'session-persistence-jsonl', disabled: false },
    { id: 'attachment-local', disabled: false },
    { id: 'storage-json', disabled: false },
    {
      id: 'agent-default-model',
      config: { provider: config.model.provider, model: config.model.name },
    },
    // The pi-ai route config is composed from several defaults; verify presence only.
    { id: 'llm-pi-ai', disabled: false },
  ];
  const systemRows: UnknownRecord[] = [];
  if (config.systemPrompt.length > 0) {
    const configValue = {
      personaPrefix: `You are a coding agent powered by the {{model}} model.\n\n${config.systemPrompt}`,
    };
    systemRows.push({ id: 'system-prompt', config: configValue });
    expected.push({ id: 'system-prompt', config: configValue });
  }
  const skillRows: UnknownRecord[] = [];
  if (config.skills !== undefined) {
    const configValue = {
      includeDefaultRoots: true,
      customSkillDirs: [config.skills],
      watch: false,
    };
    skillRows.push({ id: 'skill-filesystem', config: configValue });
    expected.push({ id: 'skill-filesystem', config: configValue });
  }
  const inserted = mcpRows(config);
  if (inserted.length > 0) {
    for (const [index, row] of inserted.entries()) {
      expected.push({
        id: String(row['id']),
        config: {
          ...(row['config'] as UnknownRecord),
          headers: mcpHeaderExpression(config.mcps[index]!),
        },
      });
    }
  }
  let mcpPatch = inserted.length > 0 ? yamlRows([{ insert: inserted }]) : '';
  for (const [index, row] of inserted.entries()) {
    const configValue = row['config'] as UnknownRecord;
    mcpPatch = mcpPatch.replace(
      String(configValue['headers']),
      mcpHeaderExpression(config.mcps[index]!),
    );
  }
  const patch = template
    .replaceAll('{{MODEL_PROVIDER}}', JSON.stringify(config.model.provider))
    .replaceAll('{{MODEL_NAME}}', JSON.stringify(config.model.name))
    .replace('{{MODEL_PROVIDERS}}', yamlRows(modelProviderRows(config)))
    .replace('{{SYSTEM_PROMPT_ROW}}', yamlRows(systemRows))
    .replace('{{SKILL_ROW}}', yamlRows(skillRows))
    .replace('{{MCP_SERVERS}}', mcpPatch);
  return { patch, expected };
}

function defaultTemplateDir(): string {
  return fileURLToPath(new URL('../../profile/', import.meta.url));
}

/** Materialize package.json, cordis.patch.yml and the empty cordis.yml under DSH_HOME/profiles/agentrun. */
export function materializeProfile(
  config: AdapterConfig,
  templateDir = defaultTemplateDir(),
): RenderedProfile {
  const template = readFileSync(join(templateDir, 'cordis.patch.yml.tmpl'), 'utf8');
  const { patch, expected } = renderPatch(config, template);
  const packageManifest = JSON.parse(readFileSync(join(templateDir, 'package.json'), 'utf8')) as {
    dsh?: { profile?: { bundles?: unknown } };
  };
  const bundles = packageManifest.dsh?.profile?.bundles;
  if (
    !Array.isArray(bundles) ||
    bundles[0] !== '@deepseek-ai/dsh-base' ||
    bundles[1] !== '@deepseek-ai/dsh-headless'
  ) {
    throw new Error('profile/package.json must bundle dsh-base followed by dsh-headless');
  }
  const rootConfig = readFileSync(join(templateDir, 'cordis.yml'), 'utf8');
  const profileDir = join(config.dsh.dshHome, 'profiles', config.dsh.profile);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`);
  writeFileSync(join(profileDir, 'cordis.patch.yml'), patch);
  writeFileSync(join(profileDir, 'cordis.yml'), rootConfig);
  return { profileDir, renderedPatch: patch, expected };
}

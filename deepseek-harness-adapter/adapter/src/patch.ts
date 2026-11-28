import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stringify } from 'yaml';

import { MODEL_API_KEY_ENV } from '@agentarts/harness-dsh-shared';

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
    // ACP 路线没有 headless-runner（由 dsh-acp-app 提供执行），不要对它做存在性对账。
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
    // The observation bundle is always mounted; it self-disables without otel config.
    { id: 'agentarts-instrumentation-dsh', disabled: false },
  ];
  if (config.memory !== undefined) {
    expected.push({ id: 'dsh-agentarts-memory', disabled: false });
  }
  // ACP 下 system prompt 由 DSH_SYSTEM_PROMPT 统一处理（promptStore + system-prompt-injector），
  // 不再通过 profile 的 system-prompt 行 personaPrefix 下发，避免同一段指令被注入两遍。
  const systemRows: UnknownRecord[] = [];
  const skillRows: UnknownRecord[] = [];
  // OBS form ("skillId:skillName:skillVer") is handled by the dsh-skill-obs bundle, which also
  // supplies customSkillDirs. Only a real local directory is rendered here.
  if (config.skills !== undefined && !isObsSkillRefs(config.skills)) {
    const configValue = {
      includeDefaultRoots: true,
      customSkillDirs: [config.skills],
      watch: false,
    };
    skillRows.push({ id: 'skill-filesystem', config: configValue });
    expected.push({ id: 'skill-filesystem', config: configValue });
  }
  // ACP 下 MCP 通过 session/new 的 mcpServers 传入，不再渲染 dsh-mcp-client 行。
  const inserted: UnknownRecord[] = [];
  const mcpPatch = '';
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

/** True when agent_metadata.skills is an OBS reference list, not a local directory. */
function isObsSkillRefs(skills: string): boolean {
  if (!skills.includes(':')) return false;
  if (/^[A-Za-z]:[\\/]/.test(skills)) return false;
  if (skills.includes('/') || skills.includes('\\')) return false;
  return true;
}

/** One Host bundle copied into the profile so DSH needs no registry install. */
interface HostPlugin {
  readonly package: string;
  readonly vendor: string;
  readonly source: string;
  /** True when the bundle has runtime dependencies that must be installed by pnpm. */
  readonly withDependencies?: boolean;
  /** Asset list override; defaults to the standard Host plugin layout. */
  readonly assets?: readonly string[];
}

/** Host bundles vendored into the profile so DSH needs no registry install. */
const HOST_PLUGINS: readonly HostPlugin[] = [
  {
    package: '@agentarts/dsh-agentarts-memory',
    vendor: 'vendor/dsh-agentarts-memory',
    source: '../../plugins/dsh-agentarts-memory/',
  },
  {
    package: '@agentarts/dsh-skill-obs',
    vendor: 'vendor/dsh-skill-obs',
    source: '../../plugins/dsh-skill-obs/',
    // esdk-obs-nodejs/fflate/yaml/agentarts-sdk are runtime dependencies of this bundle.
    withDependencies: true,
  },
  {
    package: '@agentarts/dsh-agentarts-tool-policy',
    vendor: 'vendor/dsh-agentarts-tool-policy',
    source: '../../plugins/dsh-agentarts-tool-policy/',
  },
  {
    // Vendored from the upstream release tarball; see plugins/agentarts-instrumentation-dsh/VENDORED.md.
    package: 'agentarts-instrumentation-dsh',
    vendor: 'vendor/agentarts-instrumentation-dsh',
    source: '../../plugins/agentarts-instrumentation-dsh/',
    assets: [
      'package.json',
      'dist',
      'cordis.patch.yml',
      'configure',
      'locale',
      'docs',
      'icon.svg',
      'config.example.json',
      'README.md',
      'SECURITY-NOTES.md',
    ],
  },
];

const HOST_PLUGIN_ASSETS = [
  'package.json',
  'index.js',
  'cordis.patch.yml',
  'src',
  'locale',
  'docs',
  'icon.svg',
  'README.md',
  'LICENSE',
] as const;

/** Copy every zero-dependency Host bundle into the profile so DSH needs no registry install. */
function materializeHostPlugins(profileDir: string): void {
  for (const plugin of HOST_PLUGINS) {
    const sourceDir = fileURLToPath(new URL(plugin.source, import.meta.url));
    const vendorDir = join(profileDir, plugin.vendor);
    const moduleDir = join(profileDir, 'node_modules', plugin.package);
    mkdirSync(vendorDir, { recursive: true });
    for (const asset of plugin.assets ?? HOST_PLUGIN_ASSETS) {
      cpSync(join(sourceDir, asset), join(vendorDir, asset), { recursive: true });
    }
    // pnpm install turns moduleDir into a symlink; remove it before re-copying the directory,
    // otherwise cpSync fails with ERR_FS_CP_DIR_TO_NON_DIR.
    rmSync(moduleDir, { recursive: true, force: true });
    cpSync(vendorDir, moduleDir, { recursive: true });
  }
}

/**
 * Install the profile's runtime dependencies with pnpm instead of copying the pnpm
 * link tree. Skipped when node_modules already matches the current package.json
 * fingerprint, so repeated launches do not reinstall on every invocation.
 */
function installProfileDependencies(profileDir: string, packageJson: string): void {
  const fingerprint = createHash('sha256').update(packageJson).digest('hex');
  const markerPath = join(profileDir, '.deps-fingerprint');
  if (existsSync(join(profileDir, 'node_modules')) && existsSync(markerPath)) {
    if (readFileSync(markerPath, 'utf8').trim() === fingerprint) return;
  }
  const result = spawnSync('pnpm', ['install', '--prod', '--ignore-scripts', '--reporter', 'append-only'], {
    cwd: profileDir,
    stdio: 'inherit',
    shell: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`profile dependency install failed (exit ${String(result.status)})`);
  }
  writeFileSync(markerPath, `${fingerprint}\n`);
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
    dependencies?: Record<string, string>;
  };
  const bundles = packageManifest.dsh?.profile?.bundles;
  const expectedBundles = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-acp-app',
    ...HOST_PLUGINS.map((plugin) => plugin.package),
  ];
  const bundlesMatch =
    Array.isArray(bundles) &&
    bundles.length === expectedBundles.length &&
    expectedBundles.every((name, index) => bundles[index] === name);
  const dependenciesMatch = HOST_PLUGINS.every(
    (plugin) => packageManifest.dependencies?.[plugin.package] === `file:./${plugin.vendor}`,
  );
  if (!bundlesMatch || !dependenciesMatch) {
    throw new Error(
      'profile/package.json must bundle dsh-base, dsh-acp-app and every vendored Host plugin',
    );
  }
  const rootConfig = readFileSync(join(templateDir, 'cordis.yml'), 'utf8');
  const profileDir = join(config.dsh.dshHome, 'profiles', config.dsh.profile);
  mkdirSync(profileDir, { recursive: true });
  materializeHostPlugins(profileDir);
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`);
  installProfileDependencies(profileDir, JSON.stringify(packageManifest, null, 2));
  writeFileSync(join(profileDir, 'cordis.patch.yml'), patch);
  writeFileSync(join(profileDir, 'cordis.yml'), rootConfig);
  return { profileDir, renderedPatch: patch, expected };
}

#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ADAPTER_ENV } from '@agentarts/shared';

import { configDiagnostics, loadAdapterConfig, redactEnv } from './config.js';
import { SdkCredentialProvider, StaticCredentialProvider } from './credential.js';
import { materializeProfile } from './patch.js';
import {
  AdapterPool,
  buildDshProcessSpec,
  DshLauncher,
  ResidentProcess,
} from './scheduler/index.js';
import type { ResidentSpec } from './scheduler/index.js';
import { EMPTY_RECALL } from './types.js';
import type { InvocationRequest, InvocationEnvelope } from './types.js';

const USAGE = `Usage:
  node adapter/dist/main.js render [options]   Render profile and show the exact child env (redacted)
  node adapter/dist/main.js inspect [options]  Run real DSH --dump-config and reconcile rows
  node adapter/dist/main.js demo [options]     inspect + a child probe using identical env/stdin
  node adapter/dist/main.js run [options]      inspect + official headless one-shot execution
  node adapter/dist/main.js resident [options] mock resident process: assemble once, run two rounds

Options:
  --config <path>              Mounted JSON/YAML agent_metadata file
  --metadata <json-or-yaml>    Inline agent_metadata; overrides file and environment
  --set <path=value>           Repeatable dotted override, e.g. agent_metadata.model_config.name=deepseek-chat
  --dsh-command <path>         DSH executable (default: dsh)
  --dsh-arg <arg>              Repeatable executable prefix arg, e.g. apps/cli/lib/bin.js
  --dsh-patch <path>           Repeatable extra DSH patch overlay
  --dsh-home <path>            Isolated DSH_HOME
  --dsh-cwd <path>             Child working directory
  --timeout-ms <n>             Per-child timeout (default: 300000)
  --task <text>                Invocation prompt (default: demo prompt)
  --session-id <id>            Existing DSH Session to resume; omit for a fresh Session
  --event-id <id>              Idempotency identity (default: demo-event-1)
  --attempt <n>                Platform attempt number (default: 1)
  --probe <path>               Demo child probe (default: scripts/child-probe.mjs)
  --credential-provider <p>    sdk (default in production) | static (demo env, no SDK build)
`;

function defaultProbePath(): string {
  return fileURLToPath(new URL('../../scripts/child-probe.mjs', import.meta.url));
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name}: expected a positive integer`);
  return parsed;
}

function selectedPlugins(
  plugins: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  const ids = new Set([
    'headless-runner',
    'headless-startup',
    'agent-default-model',
    'llm-pi-ai',
    'dsh-agentarts-memory',
    'dsh-skill-obs',
    'system-prompt',
    'skill-filesystem',
    'ptc-runtime',
    'workflow-ptc',
    'tool-workflow',
    'session-persistence-jsonl',
    'attachment-local',
    'storage-json',
    'dsh-agentarts-memory',
  ]);
  return plugins.filter(
    (plugin) =>
      typeof plugin['id'] === 'string' &&
      (ids.has(plugin['id']) || plugin['id'].startsWith('agentrun-mcp-')),
  );
}

/** Run the demo/inspection CLI and return a process exit code. */
export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      metadata: { type: 'string' },
      set: { type: 'string', multiple: true },
      'dsh-command': { type: 'string' },
      'dsh-arg': { type: 'string', multiple: true },
      'dsh-patch': { type: 'string', multiple: true },
      'dsh-home': { type: 'string' },
      'dsh-cwd': { type: 'string' },
      'timeout-ms': { type: 'string' },
      task: { type: 'string' },
      'session-id': { type: 'string' },
      'event-id': { type: 'string' },
      attempt: { type: 'string' },
      probe: { type: 'string' },
      'credential-provider': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0] ?? (values.help ? 'help' : undefined);
  if (command === 'help' || values.help === true || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && values.help !== true ? 1 : 0;
  }
  if (!['render', 'inspect', 'demo', 'run', 'resident'].includes(command))
    throw new Error(`unknown command ${command}; use --help`);

  const config = loadAdapterConfig({
    argv: {
      ...(values.config === undefined ? {} : { configFile: values.config }),
      ...(values.metadata === undefined ? {} : { metadata: values.metadata }),
      ...(values.set === undefined ? {} : { set: values.set }),
      ...(values['dsh-command'] === undefined ? {} : { dshCommand: values['dsh-command'] }),
      ...(values['dsh-arg'] === undefined ? {} : { dshArgs: values['dsh-arg'] }),
      ...(values['dsh-patch'] === undefined ? {} : { dshPatches: values['dsh-patch'] }),
      ...(values['dsh-home'] === undefined ? {} : { dshHome: values['dsh-home'] }),
      ...(values['dsh-cwd'] === undefined ? {} : { dshCwd: values['dsh-cwd'] }),
      ...(values['timeout-ms'] === undefined
        ? {}
        : { timeoutMs: positiveInteger(values['timeout-ms'], 300_000, '--timeout-ms') }),
    },
  });
  const invocation: InvocationRequest = {
    prompt:
      values.task ??
      'Reply with a concise greeting and mention that the DSH headless runner is working.',
    ...((values['session-id'] ?? process.env[ADAPTER_ENV.sessionId])
      ? { sessionId: values['session-id'] ?? process.env[ADAPTER_ENV.sessionId] }
      : {}),
    eventId: values['event-id'] ?? process.env[ADAPTER_ENV.eventId] ?? 'demo-event-1',
    attempt: positiveInteger(values['attempt'] ?? process.env[ADAPTER_ENV.attempt], 1, '--attempt'),
  };
  // Recall is performed inside the DSH process by dsh-agentarts-memory (agent/pre-step);
  // the Adapter no longer retrieves memories, so the envelope carries an empty recall bundle.
  const recall = EMPTY_RECALL;
  const credentialProvider =
    values['credential-provider'] === 'sdk'
      ? SdkCredentialProvider.fromRegion()
      : new StaticCredentialProvider();
  const launcher = new DshLauncher(config, credentialProvider);
  const pool = new AdapterPool(launcher);
  const processSpec = buildDshProcessSpec(config, invocation, recall, 'run');
  const base = {
    config: configDiagnostics(config),
    invocation,
    child: {
      command: processSpec.command,
      args: processSpec.args,
      cwd: processSpec.cwd,
      env: redactEnv(processSpec.env),
      stdin: processSpec.stdin,
    },
  };

  if (command === 'render') {
    const rendered = materializeProfile(config);
    return await writeReport({
      ok: true,
      mode: 'render',
      ...base,
      profileDir: rendered.profileDir,
      renderedPatch: rendered.renderedPatch,
    });
  }

  const preparation = await launcher.prepare(invocation, recall);
  const inspect = {
    profileDir: preparation.snapshot.profileDir,
    capturedAt: preparation.snapshot.capturedAt,
    pluginCount: preparation.snapshot.entries.length,
    plugins: selectedPlugins(launcher.ops.listPlugins()),
    reconcile: preparation.reconcile,
    stderr: preparation.stderr,
    durationMs: preparation.durationMs,
  };
  if (command === 'inspect')
    return await writeReport({ ok: preparation.reconcile.ok, mode: 'inspect', ...base, inspect });

  if (!preparation.reconcile.ok) {
    const skipped = { ok: false, error: 'not started because profile reconciliation failed' };
    return await writeReport(
      command === 'demo'
        ? { ok: false, mode: command, ...base, inspect, probe: skipped }
        : { ok: false, mode: command, ...base, inspect, run: skipped },
    );
  }

  if (command === 'demo') {
    const probePath = resolve(values.probe ?? defaultProbePath());
    const probe = await pool.probe(probePath, invocation, recall);
    return await writeReport({
      ok: preparation.reconcile.ok && probe.ok,
      mode: 'demo',
      ...base,
      inspect,
      probe: {
        ok: probe.ok,
        exitCode: probe.exitCode,
        error: probe.error,
        stderr: probe.stderr,
        frames: probe.frames,
      },
    });
  }

  if (command === 'resident') {
    const residentChildPath = fileURLToPath(
      new URL('../../scripts/resident-child.mjs', import.meta.url),
    );
    const residentSpec: ResidentSpec = {
      command: process.execPath,
      args: [residentChildPath],
      cwd: config.dsh.cwd,
      env: buildDshProcessSpec(config, invocation, recall, 'run').env,
      timeoutMs: config.dsh.timeoutMs,
    };
    const resident = new ResidentProcess(residentSpec);
    await resident.start();
    const envelopeFor = (prompt: string, sessionId?: string): InvocationEnvelope => ({
      ...(sessionId === undefined ? {} : { sessionId }),
      eventId: invocation.eventId,
      attempt: invocation.attempt,
      prompt,
      recall,
    });
    const first = await resident.invoke(envelopeFor(invocation.prompt, invocation.sessionId));
    const second = await resident.invoke(envelopeFor('second round', invocation.sessionId));
    await resident.dispose();
    return await writeReport({
      ok: first.ok && second.ok,
      mode: 'resident',
      ...base,
      resident: {
        assembled: true,
        rounds: [
          { ok: first.ok, final: first.final, error: first.error },
          { ok: second.ok, final: second.final, error: second.error },
        ],
      },
    });
  }

  const result = await pool.run(invocation, recall);
  return await writeReport({
    ok: preparation.reconcile.ok && result.ok,
    mode: 'run',
    ...base,
    inspect,
    run: {
      ok: result.ok,
      exitCode: result.exitCode,
      signal: result.signal,
      error: result.error,
      stderr: result.stderr,
      frames: result.frames,
      final: result.final,
    },
  });
}

async function writeReport(report: Record<string, unknown>): Promise<number> {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report['ok'] === true ? 0 : 1;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    process.stderr.write(
      `agentarts-adapter: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

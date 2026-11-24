import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadAdapterConfig } from '../src/config.js';
import { DshLauncher, runChildProcess } from '../src/scheduler/run.js';
import { SessionQueue } from '../src/scheduler/session-queue.js';

const childPath = fileURLToPath(new URL('./fixtures/fake-child.mjs', import.meta.url));
const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function spec(mode: string) {
  return {
    command: process.execPath,
    args: [childPath],
    cwd: process.cwd(),
    env: { FAKE_MODE: mode },
    stdin: 'hello child',
    timeoutMs: 5_000,
  };
}

describe('runChildProcess', () => {
  it('parses NDJSON and requires a completed final frame', async () => {
    const result = await runChildProcess(spec('success'));
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.final).toMatchObject({
      type: 'final',
      reason: { kind: 'completed' },
      text: 'ok',
    });
    expect(result.frames).toContainEqual({
      type: 'probe',
      task: 'hello child',
      eventId: undefined,
    });
  });

  it('rejects malformed NDJSON, missing final and unsuccessful exits', async () => {
    const invalid = await runChildProcess(spec('invalid'));
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain('not valid NDJSON');
    const missing = await runChildProcess(spec('no-final'));
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('without a final frame');
    const failure = await runChildProcess(spec('failure'));
    expect(failure.ok).toBe(false);
    expect(failure.error).toContain('did not complete');
    expect(failure.error).toContain('code 7');
  });

  it('terminates timed-out children and reports spawn failures', async () => {
    const timeout = await runChildProcess({ ...spec('hang'), timeoutMs: 50 });
    expect(timeout.ok).toBe(false);
    expect(timeout.error).toContain('timed out');
    const missing = await runChildProcess({
      ...spec('success'),
      command: join(tmpdir(), 'agentarts-no-such-executable'),
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('failed to spawn');
  });
});

describe('SessionQueue', () => {
  it('serializes one session, allows different sessions in parallel and recovers after rejection', async () => {
    const queue = new SessionQueue();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const work = (key: string, name: string, fail = false) =>
      queue.runExclusive(key, async () => {
        events.push(`start:${name}`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        events.push(`end:${name}`);
        if (fail) throw new Error('expected failure');
      });
    await Promise.all([
      work('a', 'a1', true).catch(() => undefined),
      work('a', 'a2'),
      work('b', 'b1'),
    ]);
    expect(events.indexOf('start:a2')).toBeGreaterThan(events.indexOf('end:a1'));
    expect(maxActive).toBe(2);
    expect(queue.size).toBe(0);
  });
});

describe('DshLauncher', () => {
  it('materializes, reconciles and launches real child processes with injected values', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentarts-launcher-'));
    cleanup.push(cwd);
    const config = loadAdapterConfig({
      cwd,
      env: {},
      argv: {
        dshHome: join(cwd, 'home'),
        dshCwd: cwd,
        dshCommand: process.execPath,
        dshArgs: [childPath],
        metadata:
          '{"agent_metadata":{"model_config":{"name":"launcher-model","api_key":"not-printed"}}}',
      },
    });
    const launcher = new DshLauncher(config);
    const invocation = { prompt: 'launcher task', eventId: 'event-launcher', attempt: 1 };
    const recall = { memory: [{ content: 'memory' }], knowledgeBases: [] };
    const prepared = await launcher.prepare(invocation, recall);
    expect(prepared.reconcile.ok).toBe(true);
    expect(prepared.snapshot.entries).toContainEqual(
      expect.objectContaining({
        id: 'agent-default-model',
        config: { provider: 'agentarts-model', model: 'launcher-model' },
      }),
    );
    const result = await launcher.run(invocation, recall);
    expect(result.ok).toBe(true);
    expect(result.frames).toContainEqual(
      expect.objectContaining({
        type: 'probe',
        task: 'launcher task',
        eventId: 'event-launcher',
      }),
    );
    const probe = await launcher.probe(childPath, invocation, recall);
    expect(probe.ok).toBe(true);
  });
});

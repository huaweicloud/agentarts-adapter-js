import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/main.js';

const childPath = fileURLToPath(new URL('./fixtures/fake-child.mjs', import.meta.url));
const probePath = fileURLToPath(new URL('../../scripts/child-probe.mjs', import.meta.url));
const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('demo CLI', () => {
  it('prints a machine-readable inspect + probe report using real child processes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentarts-cli-'));
    cleanup.push(cwd);
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(
      (() => true) as typeof process.stderr.write,
    );
    const exitCode = await runCli([
      'demo',
      '--dsh-command',
      process.execPath,
      '--dsh-arg',
      childPath,
      '--probe',
      probePath,
      '--dsh-home',
      join(cwd, 'home'),
      '--dsh-cwd',
      cwd,
      '--metadata',
      '{"agent_metadata":{"model_config":{"name":"cli-test-model","api_key":"cli-secret"}}}',
      '--task',
      'cli demo task',
      '--memory-recall',
      '[{"content":"memory"}]',
    ]);
    expect(exitCode).toBe(0);
    const report = JSON.parse(output.join('')) as Record<string, any>;
    expect(report.mode).toBe('demo');
    expect(report.ok).toBe(true);
    expect(report.inspect.pluginCount).toBeGreaterThan(0);
    const envelope = JSON.parse(report.child.stdin);
    expect(envelope.prompt).toBe('cli demo task');
    expect(envelope.recall.memory).toEqual([{ content: 'memory' }]);
    expect(envelope.eventId).toBe('demo-event-1');
    // agent_metadata is injected for dsh-skill-obs, with nested credentials redacted in the report.
    const metadata = JSON.parse(report.child.env.agent_metadata);
    expect(metadata.model_config.name).toBe('cli-test-model');
    expect(metadata.model_config.api_key).toBe('<redacted>');
    expect(report.child.env.DEEPSEEK_API_KEY).toBe('<redacted>');
    expect(report.probe.frames[1]).toMatchObject({ type: 'probe', task: 'cli demo task' });
  });
});

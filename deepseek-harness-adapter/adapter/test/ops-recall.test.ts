import { describe, expect, it } from 'vitest';

import { parseDshDump, reconcilePluginState } from '../src/ops.js';
import { recallWithFallback, StaticRecallProvider } from '../src/recall.js';
import type { RecallInput } from '../src/recall.js';
import type { AdapterConfig, InvocationRequest } from '../src/types.js';

const invocation: InvocationRequest = { prompt: 'task', eventId: 'event', attempt: 1 };

describe('ops', () => {
  it('parses composed YAML and preserves !!js without executing it', () => {
    const entries = parseDshDump(`
# == test
- id: headless-runner
  name: '@deepseek-ai/dsh-headless'
  config:
    task: !!js ctx.headlessStartup.task
    sessionId: !!js ctx.headlessStartup.sessionId
- id: agent-default-model
  config:
    provider: deepseek-official
    model: test-model
- id: ptc-runtime
  disabled: true
`);
    expect(entries[0]?.config).toMatchObject({ task: '!!js ctx.headlessStartup.task' });
    const report = reconcilePluginState(entries, [
      { id: 'headless-runner', disabled: false },
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'test-model' } },
      { id: 'ptc-runtime', disabled: true },
    ]);
    expect(report.ok).toBe(true);
  });

  it('reports missing, disabled and config mismatches, with explicit overlay override warnings', () => {
    const entries = parseDshDump(
      `[{id: agent-default-model, config: {provider: cli-mock, model: cli-mock}}, {id: ptc-runtime, disabled: false}]`,
    );
    const expected = [
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'test-model' } },
      { id: 'ptc-runtime', disabled: true },
      { id: 'headless-runner', disabled: false },
    ] as const;
    const strict = reconcilePluginState(entries, expected);
    expect(strict).toMatchObject({
      ok: false,
      missingRows: ['headless-runner'],
      disabledMismatches: ['ptc-runtime'],
      configMismatches: ['agent-default-model'],
    });
    const overlay = reconcilePluginState(entries, expected, { allowConfigOverrides: true });
    expect(overlay.configMismatches).toEqual([]);
    expect(overlay.warnings.join('\n')).toContain('additional --patch');
  });
});

describe('recall', () => {
  it('reads static memory and knowledge arrays', async () => {
    const provider = new StaticRecallProvider({
      AGENTRUN_MEMORY_RECALL: '[{"role":"user","content":"memory"}]',
      AGENTRUN_KNOWLEDGE_RECALL: '{"knowledgeBases":[{"name":"kb","results":[]}]}',
    });
    const result = await provider.recall({
      config: {} as AdapterConfig,
      invocation,
      signal: new AbortController().signal,
    });
    expect(result.memory).toHaveLength(1);
    expect(result.knowledgeBases).toEqual([{ name: 'kb', results: [] }]);
  });

  it('degrades timeout and failure to empty recall', async () => {
    const warnings: string[] = [];
    const provider = { recall: (_input: RecallInput) => new Promise<never>(() => undefined) };
    const result = await recallWithFallback(
      provider,
      { config: {} as AdapterConfig, invocation },
      (message) => warnings.push(message),
      5,
    );
    expect(result).toEqual({ memory: [], knowledgeBases: [] });
    expect(warnings[0]).toContain('timed out');
  });
});

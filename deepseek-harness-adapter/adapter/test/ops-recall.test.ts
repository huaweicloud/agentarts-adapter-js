import { describe, expect, it } from 'vitest';

import { parseDshDump, reconcilePluginState } from '../src/ops.js';

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

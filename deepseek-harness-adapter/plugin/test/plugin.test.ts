import { describe, expect, it } from 'vitest';

import { Plugin } from '@agentarts/plugin';

describe('@agentarts/plugin', () => {
  it('插件可激活', () => {
    const p = new Plugin();
    expect(p.activate()).toContain('agentarts-harness-adapter');
  });
});

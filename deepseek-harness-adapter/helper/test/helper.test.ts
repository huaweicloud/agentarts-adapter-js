import { describe, expect, it } from 'vitest';

import { banner } from '@agentarts/helper';

describe('@agentarts/helper', () => {
  it('生成 banner', () => {
    expect(banner()).toContain('agentarts-harness-adapter');
  });
});

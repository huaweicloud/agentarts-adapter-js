import { describe, expect, it } from 'vitest';

import { banner } from '../src/index.js';

describe('@agentarts/helper', () => {
  it('生成 banner', () => {
    expect(banner()).toContain('agentarts-harness-adapter');
  });
});

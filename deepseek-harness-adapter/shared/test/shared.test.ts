import { describe, expect, it } from 'vitest';

import { PKG_NAME } from '@agentarts/shared';

describe('@agentarts/shared', () => {
  it('导出项目标识', () => {
    expect(PKG_NAME).toBe('agentarts-harness-adapter');
  });
});

import { describe, expect, it } from 'vitest';

import { checkNodeVersion } from '../src/index.js';

describe('@agentarts/precheck', () => {
  it('接受新版本 Node', () => {
    expect(checkNodeVersion('v22.0.0').ok).toBe(true);
  });

  it('拒绝过旧版本 Node', () => {
    expect(checkNodeVersion('v18.18.0').ok).toBe(false);
  });
});

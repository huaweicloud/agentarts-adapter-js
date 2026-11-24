import { describe, expect, it } from 'vitest';

import { AgentRequestHandler, DshLauncher, SessionQueue } from '@agentarts/adapter';

describe('@agentarts/adapter', () => {
  it('exports the request seam and real launcher primitives', () => {
    const handler = new AgentRequestHandler();
    expect(handler.handle({ agentId: 'a1' })).toBe('handled:a1');
    expect(DshLauncher).toBeTypeOf('function');
    expect(SessionQueue).toBeTypeOf('function');
  });
});

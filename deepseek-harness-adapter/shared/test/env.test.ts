import { describe, expect, it } from 'vitest';

import { ADAPTER_ENV, AGENT_METADATA_ENV, MODEL_ENV } from '@agentarts/shared';

describe('shared env contract', () => {
  it('keeps document-facing and DSH-facing key names stable', () => {
    expect(AGENT_METADATA_ENV).toBe('agent_metadata');
    expect(ADAPTER_ENV.sessionId).toBe('AGENTRUN_DSH_SESSION_ID');
    expect(MODEL_ENV).toEqual({ apiKey: 'DEEPSEEK_API_KEY', baseUrl: 'DEEPSEEK_BASE_URL' });
  });
});

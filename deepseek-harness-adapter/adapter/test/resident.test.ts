import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ResidentProcess, type ResidentSpec } from '../src/scheduler/resident.js';
import type { InvocationEnvelope } from '../src/types.js';

const residentChild = fileURLToPath(new URL('../../scripts/resident-child.mjs', import.meta.url));

function spec(): ResidentSpec {
  return {
    command: process.execPath,
    args: [residentChild],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 5_000,
  };
}

function envelope(prompt: string, sessionId = 'sess-1'): InvocationEnvelope {
  return {
    sessionId,
    eventId: 'evt-1',
    attempt: 1,
    prompt,
    recall: { memory: [], knowledgeBases: [] },
  };
}

describe('ResidentProcess', () => {
  it('starts, runs multiple rounds and keeps the process alive', async () => {
    const resident = new ResidentProcess(spec());
    await resident.start();
    expect(resident.ready).toBe(true);

    const first = await resident.invoke(envelope('hello'));
    expect(first.ok).toBe(true);
    expect(first.final).toMatchObject({ reason: { kind: 'completed' } });
    expect(first.frames).toContainEqual(
      expect.objectContaining({ type: 'delta', text: 'echo:hello' }),
    );

    const second = await resident.invoke(envelope('world'));
    expect(second.ok).toBe(true);
    expect(second.final).toMatchObject({ text: 'done:world' });
    expect(resident.ready).toBe(true);

    await resident.dispose();
  });

  it('derives success only from final.reason.kind, never from an exit code', async () => {
    const resident = new ResidentProcess(spec());
    await resident.start();

    const failed = await resident.invoke(envelope('fail'));
    expect(failed.ok).toBe(false);
    expect(failed.final).toMatchObject({ reason: { kind: 'error' } });

    const errorFrame = await resident.invoke(envelope('error-frame'));
    expect(errorFrame.ok).toBe(false);
    expect(errorFrame.error).toContain('error frame');

    await resident.dispose();
  });

  it('restarts a crashed resident process on the next invoke', async () => {
    const resident = new ResidentProcess(spec());
    await resident.start();

    const crash = await resident.invoke(envelope('crash'));
    expect(crash.ok).toBe(false);
    expect(crash.error).toContain('exited');
    expect(resident.ready).toBe(false);

    const recovered = await resident.invoke(envelope('recovered'));
    expect(recovered.ok).toBe(true);
    expect(resident.ready).toBe(true);

    await resident.dispose();
  });
});

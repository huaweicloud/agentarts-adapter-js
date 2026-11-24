// Mock resident driver: emulates the self-hosted DSH driver's loop for
// validating the Adapter's resident-process management. The real driver is a
// Cordis plugin built later; this file only answers one envelope per stdin line.
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

const emit = (frame) => stdout.write(`${JSON.stringify(frame)}\n`);
let started = false;

function handle(envelope) {
  const prompt = typeof envelope.prompt === 'string' ? envelope.prompt : '';
  if (!started) {
    emit({
      type: 'session',
      sessionId: envelope.sessionId || process.env.AGENTRUN_DSH_SESSION_ID || 'resident-session',
      cwd: process.cwd(),
    });
    started = true;
  }
  emit({ type: 'status', phase: 'turn_start' });
  emit({
    type: 'delta',
    kind: 'text',
    text: `echo:${prompt}`,
    attemptId: envelope.attempt,
    revision: 0,
  });
  if (prompt.includes('crash')) {
    process.stderr.write('mock crash\n');
    process.exit(1);
    return;
  }
  if (prompt.includes('error-frame')) {
    emit({ type: 'error', message: 'mock error frame' });
    return;
  }
  const completed = !prompt.includes('fail');
  emit({
    type: 'final',
    sessionId: envelope.sessionId || 'resident-session',
    reason: { kind: completed ? 'completed' : 'error' },
    text: `done:${prompt}`,
  });
}

emit({ type: 'ready' });
const rl = createInterface({ input: stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    handle(JSON.parse(trimmed));
  } catch (error) {
    emit({
      type: 'error',
      message: `invalid envelope: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

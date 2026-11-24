import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.FAKE_MODE ?? 'success';

if (process.argv.includes('--dump-config')) {
  // Mirrors real DSH --dump-config: the model comes from the rendered profile patch.
  let model = 'deepseek-flash';
  try {
    const patch = readFileSync(join(process.env.DSH_HOME ?? '.', 'profiles', 'agentrun', 'cordis.patch.yml'), 'utf8');
    const matched = /model:\s*["']?([\w.-]+)["']?/.exec(patch);
    if (matched) model = matched[1];
  } catch {
    // Rendered patch unavailable in this fixture path; keep the default.
  }
  const entries = [
    {
      id: 'headless-runner',
      name: '@deepseek-ai/dsh-headless',
      config: { task: '!!js ctx.headlessStartup.task' },
    },
    { id: 'ptc-runtime', disabled: true },
    { id: 'workflow-ptc', disabled: true },
    { id: 'tool-workflow', disabled: true },
    { id: 'session-persistence-jsonl' },
    { id: 'attachment-local' },
    { id: 'storage-json' },
    { id: 'agent-default-model', config: { provider: 'agentarts-model', model } },
    { id: 'llm-pi-ai' },
  ];
  process.stdout.write(`${JSON.stringify(entries)}\n`);
} else {
  let task = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) task += chunk;
  let recall = undefined;
  let eventId = process.env.AGENTRUN_DSH_EVENT_ID;
  try {
    const envelope = JSON.parse(task);
    if (typeof envelope === 'object' && envelope !== null && typeof envelope.prompt === 'string') {
      task = envelope.prompt;
      recall = envelope.recall ?? undefined;
      eventId = envelope.eventId ?? eventId;
    }
  } catch {
    // Not an envelope: keep the raw stdin as the task.
  }
  if (mode === 'hang') {
    setInterval(() => undefined, 1_000);
  } else {
    if (mode === 'invalid') process.stdout.write('not-json\n');
    if (mode !== 'no-final') {
      process.stdout.write(
        `${JSON.stringify({ type: 'session', sessionId: 'session-test', cwd: process.cwd() })}\n`,
      );
      process.stdout.write(
        `${JSON.stringify({ type: 'probe', task, recall, eventId })}\n`,
      );
      const completed = mode !== 'failure';
      process.stdout.write(
        `${JSON.stringify({ type: 'final', sessionId: 'session-test', reason: { kind: completed ? 'completed' : 'error' }, text: completed ? 'ok' : 'failed' })}\n`,
      );
    }
    if (mode === 'failure') process.exitCode = 7;
  }
}

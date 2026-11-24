const SENSITIVE_ENV_PATTERN = /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i;

function sensitiveKey(key) {
  return SENSITIVE_ENV_PATTERN.test(key) || /headers|api_key|token|secret|credential/i.test(key);
}

function redactValue(value, key = '') {
  if (sensitiveKey(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey)]),
    );
  }
  return value;
}

function redact(key, value) {
  if (sensitiveKey(key)) return '<redacted>';
  if (key === 'agent_metadata') {
    try {
      return JSON.stringify(redactValue(JSON.parse(value)));
    } catch {
      return '<redacted>';
    }
  }
  return value;
}

let task = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) task += chunk;
let recall = undefined;
try {
  const envelope = JSON.parse(task);
  if (typeof envelope === 'object' && envelope !== null && typeof envelope.prompt === 'string') {
    task = envelope.prompt;
    recall = envelope.recall ?? undefined;
  }
} catch {
  // Not an envelope: keep the raw stdin as the task.
}
const sessionId = process.env.AGENTRUN_DSH_SESSION_ID || 'probe-session';
const env = Object.fromEntries(
  Object.entries(process.env)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, redact(key, value)]),
);
process.stdout.write(`${JSON.stringify({ type: 'session', sessionId, cwd: process.cwd() })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'probe', env, task, recall })}\n`);
process.stdout.write(
  `${JSON.stringify({
    type: 'final',
    sessionId,
    reason: { kind: 'completed' },
    text: 'Environment and stdin received; this probe does not replace the separate real DSH --dump-config check.',
  })}\n`,
);

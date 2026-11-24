import { fileURLToPath } from 'node:url';
import { runCli } from '../adapter/dist/main.js';

const defaultConfig = fileURLToPath(new URL('./demo.agentarts.yaml', import.meta.url));
const memory = JSON.stringify([
  { role: 'user', content: 'The demo user prefers concise answers.' },
]);
const knowledge = JSON.stringify([
  {
    name: 'demo-kb',
    results: [{ text: 'AgentArts hosts DSH in one child process per invocation.', score: 0.99 }],
  },
]);
const args = process.argv.slice(2);
process.exitCode = await runCli([
  'demo',
  '--config',
  defaultConfig,
  '--memory-recall',
  memory,
  '--knowledge-recall',
  knowledge,
  ...args,
]);

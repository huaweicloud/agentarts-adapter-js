import { fileURLToPath } from 'node:url';
import { runCli } from '../adapter/dist/main.js';

const defaultConfig = fileURLToPath(new URL('./demo.agentarts.yaml', import.meta.url));
process.exitCode = await runCli(['run', '--config', defaultConfig, ...process.argv.slice(2)]);

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@agentarts/shared': r('./shared/src/index.ts'),
      '@agentarts/helper': r('./helper/src/index.ts'),
      '@agentarts/adapter': r('./adapter/src/index.ts'),
      '@agentarts/precheck': r('./precheck/src/index.ts'),
    },
    extensions: ['.ts', '.mts', '.js', '.mjs', '.json'],
  },
  test: {
    environment: 'node',
    include: ['{shared,helper,adapter,plugin,precheck}/test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});

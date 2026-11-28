import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['{helper,precheck}/test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});

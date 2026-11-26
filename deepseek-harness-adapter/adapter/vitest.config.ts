import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        testTimeout: 20000,
        // 测试会 spawn 真实子进程，并行 worker 在本机触发 V8 内存分配失败；
        // 套件小，串行执行更稳（2026-11-23 执行中验证）
        fileParallelism: false,
        maxWorkers: 1,
        coverage: { provider: 'v8', include: ['src/**'], thresholds: { lines: 80 } },
    },
})
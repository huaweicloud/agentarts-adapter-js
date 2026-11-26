import { describe, expect, it } from 'vitest'

describe('runtime 包骨架', () => {
    it('入口模块可被导入', async () => {
        const mod = await import('../src/index.js')
        expect(mod).toBeTypeOf('object')
    })
})

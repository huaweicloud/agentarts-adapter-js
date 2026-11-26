import { describe, expect, it, vi } from 'vitest'
import { registerProtocolFaces } from '../src/handlers/register.js'
import { TaskRegistry } from '../src/handlers/a2a.js'
import type { Scheduler } from '../src/scheduler/index.js'

const scheduler = {} as Scheduler

describe('registerProtocolFaces', () => {
    it('SDK 面存在时注册 a2a 与 agui', () => {
        const app = { a2a: vi.fn(), agui: vi.fn() }
        registerProtocolFaces(app, scheduler, new TaskRegistry())
        expect(app.a2a).toHaveBeenCalledOnce()
        expect(app.agui).toHaveBeenCalledOnce()
    })

    it('SDK 面缺失时跳过且不抛错', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        expect(() => registerProtocolFaces({}, scheduler, new TaskRegistry())).not.toThrow()
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
    })

    it('只有 a2a 面时只注册 a2a', () => {
        const app = { a2a: vi.fn() }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        registerProtocolFaces(app, scheduler, new TaskRegistry())
        expect(app.a2a).toHaveBeenCalledOnce()
        warn.mockRestore()
    })
})
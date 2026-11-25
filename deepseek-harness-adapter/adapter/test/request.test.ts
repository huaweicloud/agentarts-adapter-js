import { describe, expect, it } from 'vitest'
import { normalizeRequest } from '../src/request.js'

describe('normalizeRequest', () => {
    it('完整 payload 原样通过', () => {
        const r = normalizeRequest({ sessionId: 's', prompt: 'p', eventId: 'e', attempt: 2 })
        expect(r).toEqual({ sessionId: 's', prompt: 'p', eventId: 'e', attempt: 2 })
    })

    it('sessionId 回退到 header，再回退到生成值', () => {
        expect(normalizeRequest({ prompt: 'p' }, 'hdr').sessionId).toBe('hdr')
        expect(normalizeRequest({ prompt: 'p' }).sessionId).toMatch(/[0-9a-f-]{36}/)
    })

    it('eventId 缺省生成，attempt 缺省 1，非法 attempt 归 1', () => {
        const r = normalizeRequest({ prompt: 'p', attempt: -3 })
        expect(r.eventId).toMatch(/[0-9a-f-]{36}/)
        expect(r.attempt).toBe(1)
    })

    it('prompt 缺失或为空抛错', () => {
        expect(() => normalizeRequest({})).toThrow('prompt is required')
        expect(() => normalizeRequest({ prompt: '' })).toThrow('prompt is required')
        expect(() => normalizeRequest({ prompt: 42 })).toThrow('prompt is required')
    })
})
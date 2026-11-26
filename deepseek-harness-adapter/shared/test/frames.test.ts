import { describe, expect, it } from 'vitest'
import { parseFrame } from '../src/index.js'

describe('parseFrame', () => {
    it('解析合法 delta 帧', () => {
        const line = JSON.stringify({
            type: 'delta', kind: 'text', text: '你', attemptId: 'a1', revision: 0,
        })
        const r = parseFrame(line)
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.frame.type).toBe('delta')
    })

    it('解析合法 final 帧', () => {
        const line = JSON.stringify({
            type: 'final', text: 'done', reason: { kind: 'completed' }, sessionId: 's1',
        })
        const r = parseFrame(line)
        expect(r.ok).toBe(true)
        if (r.ok && r.frame.type === 'final') expect(r.frame.reason.kind).toBe('completed')
    })

    it('空行与纯空白返回 empty', () => {
        expect(parseFrame('')).toEqual({ ok: false, reason: 'empty', line: '' })
        expect(parseFrame('   ').reason).toBe('empty')
    })

    it('非法 JSON 返回 invalid', () => {
        const r = parseFrame('{bad json')
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toBe('invalid')
    })

    it('未知 type 返回 invalid', () => {
        const r = parseFrame(JSON.stringify({ type: 'unknown' }))
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toBe('invalid')
    })

    it('非对象 JSON 返回 invalid', () => {
        expect(parseFrame('42').ok).toBe(false)
        expect(parseFrame('"str"').ok).toBe(false)
    })

    it('裸 final（缺 text/reason/sessionId）返回 invalid', () => {
        expect(parseFrame(JSON.stringify({ type: 'final' })).ok).toBe(false)
    })

    it('final 缺字段返回 invalid', () => {
        expect(parseFrame(JSON.stringify({ type: 'final', text: 't' })).ok).toBe(false)
        expect(parseFrame(JSON.stringify({
            type: 'final', text: 't', reason: { kind: 'completed' },
        })).ok).toBe(false)
    })

    it('error 缺 message 返回 invalid，合法 error 通过', () => {
        expect(parseFrame(JSON.stringify({ type: 'error' })).ok).toBe(false)
        expect(parseFrame(JSON.stringify({ type: 'error', message: 'm' })).ok).toBe(true)
    })
})
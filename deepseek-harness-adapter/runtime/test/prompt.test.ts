import { describe, expect, it } from 'vitest'

import { normalizeSystemPromptMode, validateSystemPrompt } from '../src/prompt.js'

describe('system prompt helpers', () => {
    it('normalizes aliases', () => {
        expect(normalizeSystemPromptMode(undefined)).toBe('append')
        expect(normalizeSystemPromptMode('add')).toBe('append')
        expect(normalizeSystemPromptMode('override')).toBe('replace')
        expect(normalizeSystemPromptMode('replaceAll')).toBe('replace-all')
    })

    it('rejects oversized prompts', () => {
        expect(() => validateSystemPrompt('x'.repeat(300_000))).toThrowError(
            /too large/,
        )
    })
})

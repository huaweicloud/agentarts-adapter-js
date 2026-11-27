import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
    MAX_SYSTEM_PROMPT_BYTES,
    SystemPromptStore,
    normalizeSystemPromptMode,
    validateSystemPrompt,
} from '../src/prompt.js'

function temporaryStore(): SystemPromptStore {
    return new SystemPromptStore(mkdtempSync(path.join(os.tmpdir(), 'prompt-store-')))
}

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

    it('accepts a prompt exactly at the size limit', () => {
        expect(validateSystemPrompt('x'.repeat(MAX_SYSTEM_PROMPT_BYTES))).toBe(
            MAX_SYSTEM_PROMPT_BYTES,
        )
    })
})

describe('system prompt store', () => {
    it('writes one sanitized file per session and removes it idempotently', () => {
        const store = temporaryStore()
        try {
            expect(store.write('sess/../a b', 'hello', 'replace')).toBe(5)
            const file = store.fileFor('sess/../a b')
            expect(path.dirname(file)).toBe(store.dir)
            expect(path.basename(file)).toBe('sess____a_b.json')
            expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
                text: 'hello',
                mode: 'replace',
            })

            store.remove('sess/../a b')
            expect(existsSync(file)).toBe(false)
            // A missing file is not an error: every turn removes its prompt.
            store.remove('sess/../a b')
        } finally {
            store.dispose()
            expect(existsSync(store.dir)).toBe(false)
        }
    })

    it('rejects empty text and unknown modes before writing', () => {
        const store = temporaryStore()
        try {
            expect(() => store.write('s', '   ', 'append')).toThrowError(/must not be empty/)
            expect(() => store.write('s', 'x', 'sideways')).toThrowError(
                /systemPromptMode is invalid/,
            )
            expect(existsSync(store.fileFor('s'))).toBe(false)
        } finally {
            store.dispose()
        }
    })

    it('reports an unwritable directory as a runtime error', () => {
        const store = new SystemPromptStore(
            path.join(os.tmpdir(), `missing-${randomUUID()}`, 'nested'),
        )
        try {
            expect(() => store.write('s', 'x', 'append')).toThrowError(
                /failed to write systemPrompt/,
            )
        } finally {
            store.dispose()
        }
    })
})

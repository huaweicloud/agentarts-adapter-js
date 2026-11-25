import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RuntimeError } from './errors.js'

export type SystemPromptMode = 'append' | 'replace' | 'replace-all'

export const MAX_SYSTEM_PROMPT_BYTES = 256_000

export function normalizeSystemPromptMode(value: unknown): SystemPromptMode {
    if (value === undefined || value === null || value === '') return 'append'
    const normalized = String(value).trim().toLowerCase()
    if (normalized === 'append' || normalized === 'add' || normalized === 'increment') return 'append'
    if (normalized === 'replace' || normalized === 'override') return 'replace'
    if (normalized === 'replace-all' || normalized === 'replaceall' || normalized === 'complete') {
        return 'replace-all'
    }
    throw new RuntimeError(`systemPromptMode is invalid: ${String(value)}`, {
        code: 'invalid_system_prompt_mode',
        statusCode: 400,
    })
}

export function validateSystemPrompt(text: string): number {
    if (typeof text !== 'string' || text.trim() === '') {
        throw new RuntimeError('systemPrompt must not be empty', {
            code: 'invalid_system_prompt',
            statusCode: 400,
        })
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_SYSTEM_PROMPT_BYTES) {
        throw new RuntimeError(`systemPrompt is too large (${bytes} bytes)`, {
            code: 'system_prompt_too_large',
            statusCode: 400,
            data: { bytes, maxBytes: MAX_SYSTEM_PROMPT_BYTES },
        })
    }
    return bytes
}

/**
 * One JSON file per ACP session. The DSH plugin reads it during
 * `system-prompt/assemble`; the adapter rewrites it before each turn.
 */
export class SystemPromptStore {
    readonly dir: string

    constructor(directory?: string) {
        this.dir = directory ?? mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-system-prompts-'))
    }

    fileFor(sessionId: string): string {
        return path.join(this.dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
    }

    write(sessionId: string, text: string, mode: unknown): number {
        const bytes = validateSystemPrompt(text)
        try {
            writeFileSync(
                this.fileFor(sessionId),
                JSON.stringify({ text, mode: normalizeSystemPromptMode(mode) }),
                { encoding: 'utf8', mode: 0o600 },
            )
        } catch (error) {
            throw new RuntimeError(`failed to write systemPrompt: ${(error as Error).message}`, {
                code: 'system_prompt_write_failed',
                statusCode: 500,
                cause: error,
            })
        }
        return bytes
    }

    remove(sessionId: string): void {
        try {
            unlinkSync(this.fileFor(sessionId))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
    }

    dispose(): void {
        rmSync(this.dir, { recursive: true, force: true })
    }
}

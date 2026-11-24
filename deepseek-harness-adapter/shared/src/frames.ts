/**
 * 帧契约（spec §3.1）：driver 写入 stdout 的 NDJSON，一行一帧。
 * 帧类型命名不带 DSH 词汇——这是跨 harness 的公共契约。
 */

export interface SessionFrame { type: 'session'; sessionId: string; cwd: string }
export interface StatusFrame {
    type: 'status'
    phase: 'turn_start' | 'step_start' | 'step_end' | 'turn_end'
}
export interface DeltaFrame {
    type: 'delta'; kind: string; text: string; attemptId: string; revision: number
}
export interface ToolCallFrame { type: 'tool_call'; callId: string; tool: string; input: unknown }
export interface ToolResultFrame {
    type: 'tool_result'; callId: string; status: string; result: unknown
}
export interface QuestionFrame {
    type: 'question'; callId: string; questions: unknown[]; timeoutSec: number
}
export interface FinalFrame {
    type: 'final'; text: string; reason: { kind: string }; sessionId: string
}
export interface ErrorFrame { type: 'error'; message: string }

export type Frame =
    | SessionFrame | StatusFrame | DeltaFrame | ToolCallFrame
    | ToolResultFrame | QuestionFrame | FinalFrame | ErrorFrame

export type ParseResult =
    | { ok: true; frame: Frame }
    | { ok: false; reason: 'empty' | 'invalid'; line: string }

const FRAME_TYPES = new Set([
    'session', 'status', 'delta', 'tool_call', 'tool_result', 'question', 'final', 'error',
])

/** 终态帧严格校验（BUG-08）：裸 final / 缺字段一律 invalid，防止"成功但无结果" */
function validTerminal(value: Record<string, unknown>): boolean {
    if (value.type === 'final') {
        const reason = value.reason as { kind?: unknown } | null | undefined
        return typeof value.text === 'string'
            && typeof value.sessionId === 'string'
            && typeof reason === 'object' && reason !== null
            && typeof reason.kind === 'string'
    }
    if (value.type === 'error') return typeof value.message === 'string'
    return true
}

/** 解析一行 NDJSON。终态帧校验必需字段；其余帧只校验 type（字段级由产帧方负责）。 */
export function parseFrame(line: string): ParseResult {
    if (line.trim() === '') return { ok: false, reason: 'empty', line }
    let value: unknown
    try {
        value = JSON.parse(line)
    } catch {
        return { ok: false, reason: 'invalid', line }
    }
    if (typeof value !== 'object' || value === null) return { ok: false, reason: 'invalid', line }
    const type = (value as { type?: unknown }).type
    if (typeof type !== 'string' || !FRAME_TYPES.has(type)) {
        return { ok: false, reason: 'invalid', line }
    }
    if (!validTerminal(value as Record<string, unknown>)) {
        return { ok: false, reason: 'invalid', line }
    }
    return { ok: true, frame: value as Frame }
}
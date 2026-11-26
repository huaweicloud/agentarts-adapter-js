import { randomUUID } from 'node:crypto'
import { JsonResponse, type RequestContext } from '@huaweicloud/agentarts-sdk/sdk/runtime'

import type { AcpRuntime } from './runtime.js'
import { RuntimeError, toRuntimeError } from './errors.js'
import type { RuntimeEvent, TurnRequest } from './types.js'

export const SESSION_HEADER = 'x-hw-agentarts-session-id'

function asString(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null
}

export function normalizePayload(payload: unknown, context?: RequestContext): TurnRequest & {
    stream: boolean
} {
    const body = (payload ?? {}) as Record<string, unknown>
    const prompt = asString(body.prompt) ?? asString(body.input) ?? asString(body.message)
    if (prompt === null) {
        throw new Error('prompt is required')
    }
    const sessionId =
        asString(body.sessionId) ?? asString(context?.sessionId) ?? randomUUID()
    // NaN 会被 setTimeout 当作 0 立即触发；非法值必须挡在入队前
    const timeoutMs = body.timeoutMs === undefined ? undefined : Number(body.timeoutMs)
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
        throw new Error('timeoutMs must be a positive 32-bit integer')
    }
    return {
        sessionId,
        prompt,
        eventId: asString(body.eventId) ?? undefined,
        attempt: typeof body.attempt === 'number' ? body.attempt : undefined,
        stream: body.stream !== false,
        ...(asString(body.cwd) === null ? {} : { cwd: asString(body.cwd) as string }),
        ...(asString(body.acpSessionId) === null
            ? {}
            : { acpSessionId: asString(body.acpSessionId) as string }),
        ...(body.mcpServers === undefined ? {} : { mcpServers: body.mcpServers as never }),
        ...(body.gateway === undefined ? {} : { gateway: body.gateway as never }),
        ...(asString(body.systemPrompt) === null
            ? {}
            : { systemPrompt: asString(body.systemPrompt) as string }),
        ...(asString(body.systemPromptMode) === null
            ? {}
            : {
                  systemPromptMode: asString(body.systemPromptMode) as
                      | 'append'
                      | 'replace'
                      | 'replace-all',
              }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(body.permission === undefined
            ? {}
            : {
                  permission:
                      typeof body.permission === 'string'
                          ? ({ mode: body.permission } as never)
                          : (body.permission as never),
              }),
    }
}

function errorResponse(error: unknown, sessionId?: string | null): JsonResponse {
    // 保留 RuntimeError 的状态码（404/409/502/503）；其余按请求错误处理
    const statusCode = error instanceof RuntimeError ? error.statusCode : 400
    return new JsonResponse({
        statusCode,
        headers: sessionId ? { [SESSION_HEADER]: sessionId } : {},
        content: {
            error: {
                code:
                    error !== null && typeof error === 'object' && 'code' in error
                        ? String((error as { code: unknown }).code)
                        : 'invalid_request',
                message: error instanceof Error ? error.message : String(error),
            },
        },
    })
}

/** `/invocations` with SSE token frames, management actions, or JSON when `stream:false`. */
export function createInvocationHandler(runtime: AcpRuntime) {
    return async (
        payload: unknown,
        context?: RequestContext,
    ): Promise<JsonResponse | AsyncIterable<Record<string, unknown>>> => {
        const body = (payload ?? {}) as Record<string, unknown>
        const action = String(body.action ?? 'prompt').toLowerCase()
        if (!['prompt', 'invoke', 'chat', 'run'].includes(action)) {
            return handleAction(runtime, action, body, context)
        }

        let request: TurnRequest & { stream: boolean }
        try {
            request = normalizePayload(payload, context)
        } catch (error) {
            return errorResponse(error, asString(body.sessionId) ?? context?.sessionId)
        }

        let handle
        try {
            handle = await runtime.runTurn(request, context?.signal)
        } catch (error) {
            return errorResponse(toRuntimeError(error), request.sessionId)
        }

        if (!request.stream) {
            const result = await handle.result
            return new JsonResponse({
                statusCode: result.ok ? 200 : result.error?.statusCode ?? 502,
                content: result.ok
                    ? {
                          output: result.output,
                          thought: result.thought,
                          stopReason: result.stopReason,
                          sessionId: result.sessionId,
                          acpSessionId: result.acpSessionId,
                          cwd: result.cwd,
                      }
                    : { error: result.error ?? { code: 'runtime_error', message: 'failed' } },
                headers: { [SESSION_HEADER]: request.sessionId },
            })
        }

        return (async function* () {
            try {
                for await (const event of handle.events) {
                    if (event.type !== 'error' && event.type !== 'run_finished') yield project(event)
                }
                const result = await handle.result
                if (result.ok) {
                    yield project({
                        type: 'run_finished',
                        stopReason: result.stopReason,
                        output: result.output,
                        thought: result.thought,
                    })
                } else {
                    const error = result.error ?? { code: 'runtime_error', message: 'failed' }
                    yield project({ type: 'error', ...error })
                }
            } finally {
                handle.cancel()
                await handle.result
            }
        })()
    }
}

export async function handleAction(
    runtime: AcpRuntime,
    action: string,
    body: Record<string, unknown>,
    context?: RequestContext,
): Promise<JsonResponse> {
    const sessionId = asString(body.sessionId) ?? asString(context?.sessionId)
    try {
        if (action === 'list' || action === 'list_sessions' || action === 'sessions') {
            const result = await runtime.listSessions({
                ...(asString(body.cwd) === null ? {} : { cwd: asString(body.cwd) as string }),
                ...(asString(body.cursor) === null ? {} : { cursor: asString(body.cursor) as string }),
            })
            return new JsonResponse({ content: result })
        }
        if (sessionId === null) {
            return new JsonResponse({
                statusCode: 400,
                content: { error: { code: 'invalid_request', message: 'sessionId is required' } },
            })
        }
        if (action === 'close') {
            const closed = await runtime.closeSession(sessionId)
            return new JsonResponse({
                content: { closed, sessionId },
                headers: { [SESSION_HEADER]: sessionId },
            })
        }
        if (action === 'cancel') {
            const cancelled = runtime.cancelSession(sessionId)
            return new JsonResponse({
                content: { cancelled, sessionId },
                headers: { [SESSION_HEADER]: sessionId },
            })
        }
        if (action === 'set_config' || action === 'config') {
            const configOptions = Array.isArray(body.configOptions)
                ? (body.configOptions as Array<{ configId: string; value: string }>)
                : undefined
            const result = await runtime.setConfig(sessionId, {
                ...(asString(body.model) === null ? {} : { model: asString(body.model) as string }),
                ...(asString(body.reasoningEffort) === null
                    ? {}
                    : { reasoningEffort: asString(body.reasoningEffort) as string }),
                ...(configOptions === undefined ? {} : { configOptions }),
            })
            return new JsonResponse({
                content: result,
                headers: { [SESSION_HEADER]: sessionId },
            })
        }
        return new JsonResponse({
            statusCode: 400,
            headers: { [SESSION_HEADER]: sessionId },
            content: { error: { code: 'invalid_action', message: `unknown action: ${action}` } },
        })
    } catch (error) {
        return errorResponse(toRuntimeError(error), sessionId)
    }
}

export function project(event: RuntimeEvent): Record<string, unknown> & { type: string } {
    switch (event.type) {
        case 'session':
            return {
                type: 'session_ready',
                sessionId: event.sessionId,
                acpSessionId: event.acpSessionId,
                cwd: event.cwd,
                reused: event.reused,
                mcpServers: event.mcpServers,
            }
        case 'text_start':
        case 'text_delta':
        case 'text_end':
        case 'text_correction':
            return { ...event }
        case 'tool_call':
        case 'tool_call_update':
            return { ...event }
        case 'usage':
            return { type: 'usage', used: event.used, size: event.size }
        case 'permission_request':
            return {
                type: 'permission_request',
                requestId: event.requestId,
                sessionId: event.sessionId,
                acpSessionId: event.acpSessionId,
                toolCall: event.toolCall,
                options: event.options,
                expiresAt: event.expiresAt,
            }
        case 'permission_resolved':
            return {
                type: 'permission_resolved',
                requestId: event.requestId,
                decision: event.decision,
                optionId: event.optionId,
                source: event.source,
            }
        case 'error':
            return {
                type: 'error',
                code: event.code,
                message: event.message,
                statusCode: event.statusCode,
                data: event.data,
            }
        case 'run_finished':
            return {
                type: 'run_finished',
                stopReason: event.stopReason,
                output: event.output,
                thought: event.thought,
            }
        default:
            return { ...event }
    }
}

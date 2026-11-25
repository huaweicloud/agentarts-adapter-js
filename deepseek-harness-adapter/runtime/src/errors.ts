export class RuntimeError extends Error {
    readonly code: string
    readonly statusCode: number
    readonly data?: unknown

    constructor(
        message: string,
        options: { code?: string; statusCode?: number; data?: unknown; cause?: unknown } = {},
    ) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause })
        this.name = 'RuntimeError'
        this.code = options.code ?? 'runtime_error'
        this.statusCode = options.statusCode ?? 500
        this.data = options.data
    }
}

export class AcpError extends Error {
    readonly code: number
    readonly data?: unknown

    constructor(message: string, code = -32603, data?: unknown) {
        super(message)
        this.name = 'AcpError'
        this.code = code
        this.data = data
    }
}

export function toRuntimeError(error: unknown): RuntimeError {
    if (error instanceof RuntimeError) return error
    if (error instanceof AcpError) {
        return new RuntimeError(error.message, {
            code: 'acp_error',
            statusCode: 502,
            data: { acpCode: error.code, acpData: error.data },
            cause: error,
        })
    }
    return new RuntimeError(error instanceof Error ? error.message : String(error), {
        code: 'internal_error',
        statusCode: 500,
        cause: error,
    })
}

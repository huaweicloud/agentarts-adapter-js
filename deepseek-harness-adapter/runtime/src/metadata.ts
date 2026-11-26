import { readFileSync } from 'node:fs'

interface Metadata {
    system_prompt?: string
    model_config?: { name?: string; base_url?: string; api_key?: string; credential_provider_name?: string }
    mcp_gateway_config?: { endpoint?: string }
}

export function readMetadata(env: NodeJS.ProcessEnv): Metadata {
    const text = env.agent_metadata ?? env.AGENT_METADATA ??
        (env.AGENT_METADATA_FILE ? readFileSync(env.AGENT_METADATA_FILE, 'utf8') : undefined)
    if (!text) return {}
    let data
    try { data = JSON.parse(text) } catch { throw new Error('Invalid agent_metadata JSON') }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid agent_metadata')
    for (const key of ['model_config', 'mcp_gateway_config']) {
        if (data[key] != null && (typeof data[key] !== 'object' || Array.isArray(data[key])))
            throw new Error('Invalid agent_metadata.' + key)
    }
    for (const value of [data.system_prompt, data.model_config?.name, data.model_config?.base_url,
        data.model_config?.api_key, data.model_config?.credential_provider_name, data.mcp_gateway_config?.endpoint]) {
        if (value != null && typeof value !== 'string') throw new Error('Invalid agent_metadata string field')
    }
    if (data.allowed_tools != null) throw new Error('agent_metadata.allowed_tools requires a supported DSH tool policy')
    return data
}

/** Variables needed by the OS, CLI, profile and model. Platform credentials stay in the parent. */
export function childEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
    const names = new Set(['PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMROOT', 'WINDIR',
        'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TZ',
        'DSH_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'DSH_TELEMETRY_DISABLED',
        'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'])
    return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string' && names.has(entry[0].toUpperCase())))
}

import { loadConfig, parseAcpChildEnv, type RuntimeConfig } from '@agentarts/harness-dsh-runtime'
import { buildChildEnv, loadAdapterConfig } from './config.js'
import { resolveCredentials, resolveRegion, SdkCredentialProvider, type CredentialProvider } from './credential.js'

/** Prepare the DSH-specific deployment config before assembling the shared protocol adapter. */
export async function loadHostedDshConfig(
    env: NodeJS.ProcessEnv = process.env,
    provider: CredentialProvider = SdkCredentialProvider.fromRegion(resolveRegion(env)),
): Promise<RuntimeConfig> {
    const configFile = env.AGENTRUN_CONFIG_FILE || env.AGENT_METADATA_FILE
    if (!configFile && !env.agent_metadata && !env.AGENT_METADATA) return loadConfig(env)

    const childEnvOverrides = parseAcpChildEnv(env.DSH_ACP_CHILD_ENV)
    const config = loadAdapterConfig({ env })

    const credentials = await resolveDeploymentCredentials(config, provider)
    const childEnv = buildChildEnv(config, env, credentials)
    childEnv.agent_metadata = JSON.stringify({ skills: config.skills, user_bucket: config.metadata.user_bucket })
    if (config.allowedTools !== null) {
        childEnv.AGENTARTS_ALLOWED_TOOLS = JSON.stringify(config.allowedTools)
    }

    const deployedServers = config.mcps.map(mcp => ({
        name: mcp.serverName,
        type: 'http',
        url: mcp.endpoint,
        headers: Object.entries(credentials.mcpHeaders[mcp.serverName] ?? mcp.headers)
            .map(([name, value]) => ({ name, value })),
    }))
    const model = config.metadata.model_config as { name?: string; base_url?: string } | undefined
    const modelName = typeof model?.name === 'string' ? model.name : undefined
    // The profile embeds the normalized AgentArts endpoint. The legacy provider still reads its own base URL.
    const legacyBaseUrl = env.DEEPSEEK_BASE_URL || model?.base_url
    if (typeof legacyBaseUrl === 'string' && legacyBaseUrl) childEnv.DEEPSEEK_BASE_URL = legacyBaseUrl
    return loadConfig({
        ...env,
        agent_metadata: JSON.stringify({ mcp_gateway_config: config.metadata.mcp_gateway_config }),
        DSH_ACP_MODEL: env.DSH_ACP_MODEL || modelName,
        DSH_AGENT_CWD: env.DSH_AGENT_CWD || env.DSH_ACP_CWD || env.AGENTRUN_DSH_CWD,
        DSH_SYSTEM_PROMPT: env.DSH_SYSTEM_PROMPT || config.systemPrompt,
        DSH_ACP_CHILD_ENV: JSON.stringify({ ...childEnv, ...childEnvOverrides }),
        AGENTRUN_ACP_MCP_SERVERS: env.AGENTRUN_ACP_MCP_SERVERS || JSON.stringify(deployedServers),
    })
}

async function resolveDeploymentCredentials(config: ReturnType<typeof loadAdapterConfig>, provider: CredentialProvider) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error('Identity credential resolution timed out')
            controller.abort(error)
            reject(error)
        }, config.dsh.timeoutMs)
    })
    try {
        return await Promise.race([resolveCredentials(config, provider, controller.signal), deadline])
    } finally {
        clearTimeout(timer)
    }
}

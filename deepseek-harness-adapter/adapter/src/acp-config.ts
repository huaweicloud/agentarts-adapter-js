import { loadConfig, parseAcpChildEnv, type RuntimeConfig } from '@agentarts/harness-dsh-runtime'
import { buildChildEnv, loadAdapterConfig } from './config.js'
import { resolveCredentials, resolveRegion, SdkCredentialProvider, type CredentialProvider } from './credential.js'

/** OBS signing credentials resolved in the Adapter process. */
export interface ObsCredentials {
    ak?: string
    sk?: string
    stsToken?: string
}

/**
 * Resolve OBS signing credentials in the Adapter process, which can reach the instance
 * metadata service (the plugin's own `dsh acp` child cannot always do so). Fails softly:
 * no credentials => warn and continue; dsh-skill-obs then attempts metadata itself.
 */
export async function resolveObsCredentialsFromSdk(): Promise<ObsCredentials> {
    try {
        const { createCredential } = await import('@huaweicloud/agentarts-sdk/sdk/utils/metadata')
        const basic = await createCredential()
        return { ak: basic.ak, sk: basic.sk, stsToken: basic.securityToken }
    } catch (error) {
        console.warn(
            `[acp-config] OBS credential resolution failed (dsh-skill-obs will retry in the child): ${
                error instanceof Error ? error.message : String(error)
            }`,
        )
        return {}
    }
}

/** Prepare the DSH-specific deployment config before assembling the shared protocol adapter. */
export async function loadHostedDshConfig(
    env: NodeJS.ProcessEnv = process.env,
    provider: CredentialProvider = SdkCredentialProvider.fromRegion(resolveRegion(env)),
    resolveObs: () => Promise<ObsCredentials> = resolveObsCredentialsFromSdk,
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

    // OBS temporary credentials are resolved here (Adapter can reach the metadata service)
    // and injected into the child env, so dsh-skill-obs hits the EnvCredentialProvider instead
    // of attempting the metadata service itself inside the `dsh acp` child.
    const obs = await resolveObs()
    if (obs.ak && obs.sk) {
        childEnv.HUAWEICLOUD_SDK_AK = obs.ak
        childEnv.HUAWEICLOUD_SDK_SK = obs.sk
        if (obs.stsToken) childEnv.HUAWEICLOUD_SDK_SECURITY_TOKEN = obs.stsToken
        console.info(
            `[acp-config] injected OBS credentials into child env (ak=${obs.ak.slice(0, 4)}…, sts=${obs.stsToken ? 'yes' : 'no'})`,
        )
    } else {
        console.warn(
            '[acp-config] no OBS credentials resolved; dsh-skill-obs will attempt the metadata service itself in the child process',
        )
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

/**
 * Configuration resolution for the OBS skill downloader.
 *
 * Sources, in priority order:
 *   1. the bundle row's config (mountDir / skills / userBucket / region / endpoint)
 *   2. `agent_metadata` JSON injected by the Adapter (`skills`, `user_bucket`)
 *   3. dedicated env vars (AGENTRUN_SKILLS, AGENTRUN_USER_BUCKET)
 *
 * @module dsh-skill-obs/config
 */

export const AGENTRUN_DIR_ENV = 'AGENTRUN_DIR'
export const SKILLS_ENV = 'AGENTRUN_SKILLS'
export const USER_BUCKET_ENV = 'AGENTRUN_USER_BUCKET'
export const OBS_ENDPOINT_ENV = 'AGENTRUN_SKILLS_OBS_ENDPOINT'
export const DEFAULT_MOUNT_DIR = '/home/agentarts/skills'

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

/** Skills live under `<AGENTRUN_DIR>/skills` (e.g. AGENTRUN_DIR=D:\ → D:/skills, equivalent on Windows). */
export function skillsDirFrom(baseDir) {
  const dir = asString(baseDir)
  if (dir === '') return ''
  return dir.replace(/[\\/]+$/, '') + '/skills'
}

/**
 * Parse the OBS form of skills: "skillId:skillName:skillVer, ...".
 *
 * @param {string} raw - skills metadata string
 * @returns {Array<{id: string, name: string, version?: string}>} parsed references
 */
export function parseSkillRefs(raw) {
  const text = asString(raw)
  if (text === '' || !text.includes(':')) return []
  // Local directory forms (Windows drive letters, POSIX paths) are not OBS references.
  if (/^[A-Za-z]:[\\/]/.test(text) || text.includes('/') || text.includes('\\')) return []
  const refs = []
  for (const entry of text.split(',')) {
    const trimmed = entry.trim()
    if (trimmed === '') continue
    const parts = trimmed.split(':')
    if (parts.length < 2) throw new Error(`invalid skill reference "${trimmed}" (expected id:name[:version])`)
    const [id, name, version] = parts
    if (!id || !name) throw new Error(`invalid skill reference "${trimmed}" (empty id or name)`)
    refs.push({ id, name, ...(version ? { version } : {}) })
  }
  return refs
}

/**
 * Read skills/user_bucket out of the Adapter-injected agent_metadata JSON.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{skills?: string, userBucket?: string}}
 */
export function fromAgentMetadata(env) {
  const raw = env.agent_metadata
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const parsed = JSON.parse(raw)
    const metadata = parsed?.agent_metadata ?? parsed
    return {
      ...(typeof metadata?.skills === 'string' ? { skills: metadata.skills } : {}),
      ...(typeof metadata?.user_bucket === 'string' ? { userBucket: metadata.user_bucket } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Resolve a raw bundle config plus the process environment into one config.
 *
 * @param {object|undefined} raw - the row's config from cordis.patch.yml
 * @param {Record<string, string|undefined>} [env]
 * @returns {object} resolved configuration
 */
export function resolveConfig(raw, env = process.env) {
  const r = raw !== null && typeof raw === 'object' ? raw : {}
  const metadata = fromAgentMetadata(env)
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    mountDir: asString(r.mountDir) || skillsDirFrom(env[AGENTRUN_DIR_ENV]) || DEFAULT_MOUNT_DIR,
    skills: asString(r.skills) || asString(metadata.skills) || asString(env[SKILLS_ENV]),
    userBucket: asString(r.userBucket) || asString(metadata.userBucket) || asString(env[USER_BUCKET_ENV]),
    region:
      asString(r.region) ||
      asString(env.HUAWEICLOUD_SDK_REGION) ||
      asString(env.HUAWEICLOUD_REGION) ||
      asString(env.OS_REGION_NAME) ||
      'cn-southwest-2',
    // Test/demo hook: scheme://host override that skips cloud signing entirely.
    endpoint: asString(r.endpoint) || asString(env[OBS_ENDPOINT_ENV]),
    // Real OBS service endpoint (virtual-hosted style), injected by the platform.
    obsEndpoint: asString(r.obsEndpoint) || asString(env.OBS_ENDPOINT),
    // Default: reuse a valid extracted skill (cache). Set forceRefresh=true (or AGENTRUN_SKILLS_FORCE_REFRESH=1)
    // to force a full re-download on every launch.
    forceRefresh: typeof r.forceRefresh === 'boolean' ? r.forceRefresh : false,
  }
}

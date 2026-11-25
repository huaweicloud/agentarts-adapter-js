/**
 * Config resolution and the three capability switches.
 *
 * Deployment coordinates (space, region, endpoint, actor) are read from the
 * environment first, because that is the only channel a hosted DSH process is
 * given at runtime; the values in the bundle patch row act as a local fallback.
 * The environment names match the AgentArts memory toolkit
 * (`agentarts-sdk` → `assets/toolkit/plugins/memory`), so one set of exports
 * configures the DSH plugin, the MCP server and the hook scripts alike:
 *
 * | variable | required | meaning |
 * | --- | --- | --- |
 * | `HUAWEICLOUD_SDK_MEMORY_API_KEY` | yes | data-plane API key (Bearer) |
 * | `AGENTARTS_MEMORY_SPACE_ID` | yes | memory space id |
 * | `HUAWEICLOUD_SDK_REGION` / `HUAWEICLOUD_REGION` / `OS_REGION_NAME` | no | region, default `cn-southwest-2` |
 * | `AGENTARTS_MEMORY_DATA_ENDPOINT` | no | data-plane URL override |
 * | `AGENTARTS_MEMORY_USER_ID` | no | `actor_id`; must match the writer or recall silently returns nothing |
 * | `AGENTARTS_MEMORY_RERANK` | no | `1`/`true` on, `0`/`false` off, default on |
 *
 * The plugin is deliberately dependency-free: it does not import any
 * `@deepseek-ai/*` package, so it also does not export a schemastery `Config`.
 * Every value is validated here instead, which keeps `apply()` total — a bad
 * config degrades to defaults plus a warning rather than a failed activation.
 *
 * @module dsh-agentarts-memory/config
 */

/** Builtin memory strategies accepted by the AgentArts memory backend. */
export const STRATEGY_TYPES = ['semantic', 'episodic', 'user_preference', 'summary', 'procedural']

/** Environment variable the AgentArts Memory data plane uses for its API key. */
export const DEFAULT_API_KEY_ENV = 'HUAWEICLOUD_SDK_MEMORY_API_KEY'

/** Memory space id. Required for any cloud call. */
export const ENV_SPACE_ID = 'AGENTARTS_MEMORY_SPACE_ID'

/** Region chain, same precedence as `agentarts-sdk`'s `getRegion()`. */
export const ENV_REGION = 'HUAWEICLOUD_SDK_REGION'
export const ENV_REGION_ALT = 'HUAWEICLOUD_REGION'
export const ENV_REGION_OS = 'OS_REGION_NAME'

/** Data-plane base URL override. */
export const ENV_ENDPOINT = 'AGENTARTS_MEMORY_DATA_ENDPOINT'

/** `actor_id` used for recall and capture; must equal the writer's actor id. */
export const ENV_USER_ID = 'AGENTARTS_MEMORY_USER_ID'

/** Search reranking toggle (`1`/`true` on, `0`/`false` off). */
export const ENV_RERANK = 'AGENTARTS_MEMORY_RERANK'

/** Default data-plane region (same as the SDK). */
export const DEFAULT_REGION = 'cn-southwest-2'

/** Default actor id when neither the environment nor the config sets one. */
export const DEFAULT_ACTOR_ID = 'dsh-user'

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * Resolve the data-plane region: `HUAWEICLOUD_SDK_REGION` > `HUAWEICLOUD_REGION`
 * > `OS_REGION_NAME` > the patch row's `region` > `cn-southwest-2`.
 *
 * @param {object|undefined} raw - bundle patch config
 * @param {Record<string, string|undefined>} [env] - environment source
 * @returns {string}
 */
export function resolveRegion(raw, env = process.env) {
  const r = raw !== null && typeof raw === 'object' ? raw : {}
  return (
    asString(env[ENV_REGION]) ||
    asString(env[ENV_REGION_ALT]) ||
    asString(env[ENV_REGION_OS]) ||
    asString(r.region) ||
    DEFAULT_REGION
  )
}

/**
 * Parse `AGENTARTS_MEMORY_RERANK`. Unset/unknown values fall back to `fallback`.
 *
 * @param {Record<string, string|undefined>} [env] - environment source
 * @param {boolean} [fallback] - value when the variable is absent or not boolean-like
 * @returns {boolean}
 */
export function resolveRerank(env = process.env, fallback = true) {
  const value = asString(env[ENV_RERANK]).toLowerCase()
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return fallback
}

/**
 * Resolve a raw bundle config into a fully defaulted configuration.
 *
 * Precedence is environment first, then the patch row, then the built-in
 * default. A hosted process is configured purely by exports; the row only
 * matters for a local run without them.
 *
 * @param {object|undefined} raw - config object from the bundle patch row.
 * @param {Record<string, string|undefined>} [env] - environment source
 * @returns {object} resolved configuration
 */
export function resolveConfig(raw, env = process.env) {
  const r = raw !== null && typeof raw === 'object' ? raw : {}
  const recall = r.recall !== null && typeof r.recall === 'object' ? r.recall : {}
  const tools = r.tools !== null && typeof r.tools === 'object' ? r.tools : {}
  const capture = r.capture !== null && typeof r.capture === 'object' ? r.capture : {}

  return {
    enabled: asBool(r.enabled, true),
    spaceId: asString(env[ENV_SPACE_ID]) || asString(r.spaceId),
    apiKeyEnv: asString(r.apiKeyEnv) || DEFAULT_API_KEY_ENV,
    region: resolveRegion(r, env),
    // Empty: gateway falls back to $AGENTARTS_MEMORY_DATA_ENDPOINT (already
    // folded in here) and finally the region default.
    endpoint: asString(env[ENV_ENDPOINT]) || asString(r.endpoint),
    actorId: asString(env[ENV_USER_ID]) || asString(r.actorId) || DEFAULT_ACTOR_ID,
    assistantId: asString(r.assistantId) || 'dsh',
    strategyId: asString(r.strategyId),
    strategyType: asString(r.strategyType) || 'semantic',
    timeoutMs: asNumber(r.timeoutMs, 5000, { min: 100, max: 120000 }),
    rerank: resolveRerank(env, asBool(r.rerank, true)),
    recall: {
      enabled: asBool(recall.enabled, true),
      topK: Math.round(asNumber(recall.topK, 5, { min: 1, max: 50 })),
      minScore: asNumber(recall.minScore, 0.35, { min: 0, max: 1 }),
      maxInjectTokens: Math.round(asNumber(recall.maxInjectTokens, 600, { min: 50, max: 8000 })),
      cacheMs: asNumber(recall.cacheMs, 60000, { min: 0, max: 3600000 }),
      minQueryChars: Math.round(asNumber(recall.minQueryChars, 8, { min: 0, max: 2000 })),
    },
    tools: {
      enabled: asBool(tools.enabled, true),
    },
    capture: {
      enabled: asBool(capture.enabled, false),
      maxMessages: Math.round(asNumber(capture.maxMessages, 40, { min: 1, max: 400 })),
    },
  }
}

/**
 * Whether the plugin can talk to the cloud at all: a space id and an API key.
 *
 * @param {object} config - resolved configuration
 * @param {Record<string, string|undefined>} [env] - environment source
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkReady(config, env = process.env) {
  if (!config.enabled) return { ok: false, reason: 'plugin disabled (enabled: false)' }
  if (config.spaceId === '') {
    return { ok: false, reason: `space id is not set (export ${ENV_SPACE_ID})` }
  }
  if ((env[config.apiKeyEnv] ?? '') === '') {
    return { ok: false, reason: `environment variable ${config.apiKeyEnv} is empty` }
  }
  return { ok: true }
}

/**
 * One-line human readable summary of the switches, used by `/agentarts`.
 *
 * @param {object} config - resolved configuration
 * @returns {string}
 */
export function describeSwitches(config) {
  const flag = (on) => (on ? 'on' : 'off')
  return [
    `plugin ${flag(config.enabled)}`,
    `tools ${flag(config.tools.enabled)}`,
    `recall ${flag(config.recall.enabled)}`,
    `capture ${flag(config.capture.enabled)}`,
  ].join(' · ')
}

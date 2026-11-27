/**
 * Resolve the deployment allow list and translate AgentArts capability names
 * into DSH tool names.
 *
 * @module dsh-agentarts-tool-policy/config
 */

/** Canonical environment key the Adapter writes into the DSH child environment. */
export const ALLOW_ENV = 'AGENTARTS_ALLOWED_TOOLS'

/** AgentArts `allowed_tools` wildcard: every tool is permitted, no restriction. */
const WILDCARD = '*'

/**
 * AgentArts platform capability name → DSH tool name(s).
 *
 * `bash`/`pwsh` are platform-conditional in DSH (only one is registered per OS),
 * so both are emitted as candidates and the caller filters them against the live
 * tool registry. `list_files` has no DSH equivalent: DSH lists files via `glob`.
 */
const AGENTARTS_TO_DSH = {
  bash: ['bash', 'pwsh'],
  read_file: ['read'],
  write_file: ['write'],
  edit_file: ['edit'],
  glob: ['glob'],
  list_files: ['glob'],
  grep: ['grep'],
}

/**
 * @param {unknown[]} [list]
 * @returns {string[]}
 */
function normalize(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const result = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const entry = item.trim()
    if (entry === '' || seen.has(entry)) continue
    seen.add(entry)
    result.push(entry)
  }
  return result
}

/**
 * @param {string | undefined} value
 * @returns {string[] | null} null when the variable is absent or not a usable list
 */
function parseAllowEnv(value) {
  if (value === undefined || value === '') return null
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const names = normalize(parsed)
  return names.length > 0 ? names : null
}

/**
 * @param {object} [rawConfig]
 * @returns {{ wildcard: boolean, tools: string[], unknown: string[] }}
 */
export function resolveAllowList(rawConfig) {
  const names = parseAllowEnv(process.env[ALLOW_ENV]) ?? normalize(rawConfig?.allow)
  if (names.includes(WILDCARD)) return { wildcard: true, tools: [], unknown: [] }

  const tools = new Set()
  const unknown = []
  for (const name of names) {
    const dsh = AGENTARTS_TO_DSH[name]
    if (dsh === undefined) {
      unknown.push(name)
      continue
    }
    for (const tool of dsh) tools.add(tool)
  }
  return { wildcard: false, tools: [...tools], unknown }
}
/**
 * Resolve the deployment allow list and translate AgentArts capability names
 * into DSH tool names.
 *
 * `allowed_tools` is a **whitelist of AgentArts capability names** (`read_file`,
 * `write_file`, `edit_file`, `glob`, `list_files`, `grep`, `bash`). Once it is
 * configured (and does not contain the `*` wildcard), every global tool the list
 * does not name — after translation — is denied.
 *
 * Only capability names are recognised: a DSH tool name written verbatim
 * (`read`, `read_image`, …) is not a whitelist entry and is reported as unknown.
 * A configured list that translates to nothing therefore denies every global
 * tool; it never degrades to "no restriction". Only an absent list (or `*`)
 * permits everything.
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
 * so both are emitted as candidates. `list_files` has no DSH equivalent: DSH
 * lists files via `glob`.
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
 * @returns {string[] | null} the parsed names, or null when the variable is
 *   absent, empty, or not a JSON array (i.e. no list was configured)
 */
function parseAllowEnv(value) {
  if (value === undefined || value === '') return null
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  return Array.isArray(parsed) ? normalize(parsed) : null
}

/**
 * @param {object} [rawConfig]
 * @returns {{ specified: boolean, wildcard: boolean, tools: string[], unknown: string[] }}
 *   `specified: false` means no whitelist was configured (permit everything).
 *   `wildcard: true` means `*` was named (permit everything).
 *   `unknown` lists configured names that are not AgentArts capabilities; they
 *   grant nothing. `tools` is the translated allow list, so an empty `tools`
 *   denies every global tool.
 */
export function resolveAllowList(rawConfig) {
  const envNames = parseAllowEnv(process.env[ALLOW_ENV])
  const configured = envNames !== null || rawConfig?.allow !== undefined
  if (!configured) return { specified: false, wildcard: false, tools: [], unknown: [] }

  const names = envNames ?? normalize(rawConfig?.allow)
  if (names.includes(WILDCARD)) return { specified: true, wildcard: true, tools: [], unknown: [] }

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
  return { specified: true, wildcard: false, tools: [...tools], unknown }
}
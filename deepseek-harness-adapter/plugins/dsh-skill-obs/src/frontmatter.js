/**
 * SKILL.md frontmatter validation and repair (strict YAML via the yaml package).
 *
 * DSH's skill-filesystem drops a skill whose frontmatter is invalid. The most
 * common breakage from user uploads is an unquoted `description` containing
 * ": " (colon + space); that single case is fixed automatically. Everything
 * else (missing block, missing name/description, invalid YAML) is reported.
 *
 * @module dsh-skill-obs/frontmatter
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { parse } from 'yaml'

/** Validate a frontmatter block; returns an error message, or undefined when valid. */
export function validateFrontmatter(frontmatter) {
  const data = parse(frontmatter, { logLevel: 'silent' })
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return 'frontmatter is not a mapping'
  }
  if (typeof data.name !== 'string' || data.name.trim() === '') return 'frontmatter requires name'
  if (typeof data.description !== 'string' || data.description.trim() === '') {
    return 'frontmatter requires description'
  }
  return undefined
}

function quoteDescription(frontmatter) {
  return frontmatter.replace(/^(\s*description:\s*)(.+)$/m, (_line, lead, value) => {
    const trimmed = value.trim()
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) return `${lead}${value}`
    const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return `${lead}"${escaped}"`
  })
}

/**
 * Repair SKILL.md in place when the description needs quoting.
 *
 * @param {string} skillMdPath - absolute path of the extracted SKILL.md
 * @returns {{fixed: string[], error?: string}} applied fixes and remaining error
 */
export function fixFrontmatter(skillMdPath) {
  const raw = readFileSync(skillMdPath, 'utf8')
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (match === null) return { fixed: [], error: 'missing YAML frontmatter' }
  const frontmatter = match[1]

  const errorOf = (text) => {
    try {
      return validateFrontmatter(text)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  const initialError = errorOf(frontmatter)
  if (initialError === undefined) return { fixed: [] }

  // yaml may either throw on ": " or fold it into a nested map; both need the quote repair.
  const repaired = quoteDescription(frontmatter)
  if (repaired === frontmatter) return { fixed: [], error: initialError }

  const remainingError = errorOf(repaired)
  if (remainingError !== undefined) return { fixed: [], error: remainingError }
  writeFileSync(skillMdPath, raw.replace(frontmatter, repaired), 'utf8')
  return { fixed: ['description quoted'] }
}

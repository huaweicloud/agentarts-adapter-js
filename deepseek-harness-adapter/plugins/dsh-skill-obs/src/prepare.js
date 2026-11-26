/**
 * Full skill materialization: download every declared zip, extract it into the
 * mount directory (force-refreshed), delete the archive, repair frontmatter.
 *
 * Per-skill failures are collected into the returned summary instead of
 * aborting the launch; the caller decides how to surface them.
 *
 * @module dsh-skill-obs/prepare
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parseSkillRefs } from './config.js'
import { fixFrontmatter, validateFrontmatter } from './frontmatter.js'
import { obsObjectKey, resolveObsCredentials, createObsClient, AK_ENV, SK_ENV } from './obs.js'
import { assertSafeEntry, readZipEntries, MAX_TOTAL_BYTES } from './zip.js'

/** True when targetDir already holds a SKILL.md with valid frontmatter (cache hit). */
function hasValidSkillMd(skillMdPath) {
  if (!existsSync(skillMdPath)) return false
  try {
    const raw = readFileSync(skillMdPath, 'utf8')
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (match === null) return false
    return validateFrontmatter(match[1]) === undefined
  } catch {
    return false
  }
}

/**
 * Extract one downloaded zip into the mount directory.
 *
 * Layout A ("<name>/SKILL.md") extracts into the mount root; layout B
 * ("SKILL.md" at zip root) extracts into mount/<skillName>.
 *
 * @param {Buffer} bytes - raw zip bytes
 * @param {{name: string}} ref - skill reference
 * @param {string} mountDir - extraction root
 * @returns {string} directory that now contains SKILL.md
 */
export function extractZip(bytes, ref, mountDir) {
  const entries = readZipEntries(bytes)
  const skillMd = entries.map((entry) => entry.path).find((path) => path === 'SKILL.md' || path.endsWith('/SKILL.md'))
  if (skillMd === undefined) throw new Error('zip contains no SKILL.md')
  const prefix = skillMd.slice(0, skillMd.length - 'SKILL.md'.length)
  const targetRoot = prefix === '' ? ref.name : prefix.replace(/\/$/, '')
  if (targetRoot.includes('..') || targetRoot.startsWith('/')) throw new Error('unsafe skill root in zip')
  let total = 0
  for (const entry of entries) {
    if (prefix !== '' && !entry.path.startsWith(prefix)) continue
    const rel = prefix === '' ? entry.path : entry.path.slice(prefix.length)
    if (rel === '') continue
    assertSafeEntry(rel, entry.data.byteLength)
    total += entry.data.byteLength
    if (total > MAX_TOTAL_BYTES) throw new Error('zip expands beyond size limit')
    const dest = join(mountDir, targetRoot, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, entry.data)
  }
  return join(mountDir, targetRoot)
}

/**
 * Download and materialize every skill declared in the configuration.
 *
 * @param {object} config - resolved config from resolveConfig
 * @param {{env?: Record<string, string|undefined>, fetchImpl?: typeof fetch, credentialFactory?: Function, log?: {warn: Function}}} [options]
 * @returns {Promise<{mountDir: string, dirs: string[], items: Array, warnings: string[]}>}
 */
export async function prepareAll(config, options = {}) {
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl ?? fetch
  const mountDir = config.mountDir
  const refs = parseSkillRefs(config.skills)
  if (refs.length === 0) return { mountDir, dirs: [], items: [], warnings: [] }
  if (config.userBucket === '' && config.endpoint === '') {
    throw new Error('agent_metadata.user_bucket (or AGENTRUN_USER_BUCKET) is required with OBS skills')
  }
  mkdirSync(mountDir, { recursive: true })
  const items = []
  const warnings = []

  for (const ref of refs) {
    const targetDir = join(mountDir, ref.name)
    // Default (forceRefresh is not true): reuse an already-valid extracted skill (SFS shared cache).
    if (config.forceRefresh !== true && hasValidSkillMd(join(targetDir, 'SKILL.md'))) {
      items.push({ id: ref.id, name: ref.name, ok: true, dir: targetDir, fixed: [], cached: true })
      continue
    }
    try {
      // Refresh when forced, or when an existing copy is present but invalid.
      if (config.forceRefresh === true || existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true })
      let bytes
      const zipPath = join(mountDir, `.download-${ref.name}-${Date.now()}.zip`)
      if (config.endpoint !== '') {
        // Test/demo endpoint: plain HTTP fetch, no cloud signing.
        const url = `${config.endpoint.replace(/\/$/, '')}/${obsObjectKey(ref)}`
        const response = await fetchImpl(url, {})
        if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
        bytes = Buffer.from(await response.arrayBuffer())
      } else {
        // Real OBS: ObsClient.getObject writes binary directly to SaveAsFile. Reading
        // InterfaceResult.Content would UTF-8-decode the zip and corrupt it.
        const credentials = await resolveObsCredentials(env, options.credentialFactory)
        if (!credentials.ak || !credentials.sk) {
          throw new Error(`OBS download requires credentials via agentarts-sdk createCredential() or ${AK_ENV}/${SK_ENV}`)
        }
        const endpoint = config.obsEndpoint || `https://obs.${config.region}.myhuaweicloud.com`
        const client = (options.obsClientFactory ?? createObsClient)(credentials, endpoint)
        const result = await client.getObject({ Bucket: config.userBucket, Key: obsObjectKey(ref), SaveAsFile: zipPath })
        if (result.CommonMsg.Status >= 300) {
          throw new Error(`download failed: OBS ${result.CommonMsg.Status}`)
        }
        bytes = readFileSync(zipPath)
      }
      try {
        const dir = extractZip(bytes, ref, mountDir)
        const { fixed, error } = fixFrontmatter(join(dir, 'SKILL.md'))
        items.push({ id: ref.id, name: ref.name, ok: error === undefined, dir, fixed, ...(error ? { error } : {}) })
      } finally {
        rmSync(zipPath, { force: true })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      items.push({ id: ref.id, name: ref.name, ok: false, fixed: [], error: message })
    }
    const latest = items[items.length - 1]
    if (!latest.ok) warnings.push(`skill ${ref.name}: ${latest.error}`)
  }
  return { mountDir, dirs: [mountDir], items, warnings }
}

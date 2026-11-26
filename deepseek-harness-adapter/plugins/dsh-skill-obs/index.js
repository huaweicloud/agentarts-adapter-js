/**
 * dsh-skill-obs — download AgentArts skills from OBS before the model runs.
 *
 * On mount the plugin starts downloading every skill declared in
 * `agent_metadata.skills` (skillId:skillName:skillVer, ...) from the user's OBS
 * bucket into the SFS mount directory. The download is awaited on the first
 * `agent/pre-step`, so the catalog assembled for the first model call already
 * sees the extracted skills.
 *
 * Directory injection is separate and static: cordis.patch.yml points
 * skill-filesystem.customSkillDirs at the same mount directory, so the path is
 * known to DSH long before the archives finish downloading.
 *
 * @module @agentarts/dsh-skill-obs
 */

import { resolveConfig } from './src/config.js'
import { prepareAll } from './src/prepare.js'
import { createLogger } from './src/log.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-skill-obs'

/**
 * Mount the downloader and wait for it during mount.
 *
 * `apply` returns a Promise, and Cordis's `_execute` awaits a promise returned by a plugin,
 * so `loader.await()` (which headless-runner awaits before creating the agent) does not finish
 * until every skill is downloaded and extracted. The catalog assembled at the first pre-step
 * therefore already sees the skills — awaiting on pre-step alone would be too late.
 *
 * @param {object} ctx - Cordis plugin context
 * @param {object} [rawConfig] - the row's config from cordis.patch.yml
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = createLogger(ctx, name)
  if (!config.enabled) {
    log.info('disabled (enabled: false)')
    return
  }

  const summary = await prepareAll(config, { log }).catch((error) => {
    log.warn(`prepare failed: ${error instanceof Error ? error.message : String(error)}`)
    return { mountDir: config.mountDir, dirs: [], items: [], warnings: [String(error)] }
  })
  for (const warning of summary.warnings) log.warn(warning)
  const failed = summary.items.filter((item) => !item.ok)
  if (failed.length > 0) {
    log.warn(`${failed.length}/${summary.items.length} skill(s) failed to prepare; see report`)
  } else if (summary.items.length > 0) {
    log.info(`prepared ${summary.items.length} skill(s) into ${summary.mountDir}`)
  }
}

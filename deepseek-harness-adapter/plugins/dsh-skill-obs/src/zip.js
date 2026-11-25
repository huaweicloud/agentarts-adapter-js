/**
 * ZIP helpers for skill bundles, backed by fflate.
 *
 * @module dsh-skill-obs/zip
 */

import { unzipSync } from 'fflate'

export const MAX_ZIP_ENTRIES = 500
export const MAX_ENTRY_BYTES = 32 * 1024 * 1024
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024

/**
 * Read every file entry of a zip buffer (directories excluded).
 *
 * @param {Buffer|Uint8Array} buffer - raw zip bytes
 * @returns {Array<{path: string, data: Buffer}>} inflated file entries
 */
export function readZipEntries(buffer) {
  const entries = unzipSync(buffer)
  const files = Object.entries(entries)
  if (files.length > MAX_ZIP_ENTRIES) throw new Error(`zip has too many entries (${files.length})`)
  return files
    .filter(([path]) => !path.endsWith('/'))
    .map(([path, data]) => ({ path, data: Buffer.from(data) }))
}

/**
 * Guard against zip-slip and resource exhaustion before an entry is written.
 *
 * @param {string} relativePath - entry path relative to the extraction root
 * @param {number} size - inflated byte length
 */
export function assertSafeEntry(relativePath, size) {
  if (relativePath.includes('..') || relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) {
    throw new Error(`unsafe zip entry path: ${relativePath}`)
  }
  if (relativePath.includes('\\')) throw new Error(`backslash in zip entry path: ${relativePath}`)
  if (size > MAX_ENTRY_BYTES) throw new Error(`zip entry too large: ${relativePath}`)
}

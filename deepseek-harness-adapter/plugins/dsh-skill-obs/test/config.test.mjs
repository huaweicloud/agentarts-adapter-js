import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AGENTRUN_DIR_ENV, DEFAULT_MOUNT_DIR, resolveConfig, skillsDirFrom } from '../src/config.js'

test('skillsDirFrom appends the skills subdirectory under AGENTRUN_DIR', () => {
  assert.equal(skillsDirFrom('/home/agentarts'), '/home/agentarts/skills')
  assert.equal(skillsDirFrom('/home/agentarts/'), '/home/agentarts/skills')
  // Windows drive root: trailing separator is trimmed, then '/skills' is appended
  // (forward slash is equivalent to the backslash form on Windows).
  assert.equal(skillsDirFrom('D:\\'), 'D:/skills')
})

test('skillsDirFrom returns an empty string for a blank base directory', () => {
  assert.equal(skillsDirFrom(''), '')
  assert.equal(skillsDirFrom('   '), '')
})

test('resolveConfig derives mountDir from AGENTRUN_DIR with a skills suffix', () => {
  const config = resolveConfig({}, { [AGENTRUN_DIR_ENV]: '/opt/agentarts' })
  assert.equal(config.mountDir, '/opt/agentarts/skills')
})

test('resolveConfig prefers an explicit mountDir over AGENTRUN_DIR', () => {
  const config = resolveConfig({ mountDir: '/custom/skills' }, { [AGENTRUN_DIR_ENV]: '/opt/agentarts' })
  assert.equal(config.mountDir, '/custom/skills')
})

test('resolveConfig falls back to the default mount directory', () => {
  const config = resolveConfig({}, {})
  assert.equal(config.mountDir, DEFAULT_MOUNT_DIR)
  assert.equal(config.mountDir, '/home/agentarts/skills')
})
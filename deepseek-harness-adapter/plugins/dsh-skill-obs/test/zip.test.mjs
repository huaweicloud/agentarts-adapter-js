import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zipSync } from 'fflate'

import { assertSafeEntry, readZipEntries } from '../src/zip.js'

test('readZipEntries inflates store and deflate entries', () => {
  const zip = zipSync({
    'json-processor/SKILL.md': Buffer.from('---\nname: json-processor\n---\n'),
    'json-processor/scripts/a.txt': Buffer.from('hello'),
  })
  const entries = readZipEntries(zip)
  const paths = entries.map((entry) => entry.path).sort()
  assert.deepEqual(paths, ['json-processor/SKILL.md', 'json-processor/scripts/a.txt'])
  const skill = entries.find((entry) => entry.path.endsWith('SKILL.md'))
  assert.match(skill.data.toString('utf8'), /json-processor/)
})

test('assertSafeEntry rejects traversal, absolute and backslash paths', () => {
  assert.throws(() => assertSafeEntry('../evil', 1), /unsafe/)
  assert.throws(() => assertSafeEntry('/abs', 1), /unsafe/)
  assert.throws(() => assertSafeEntry('C:/evil', 1), /unsafe/)
  assert.throws(() => assertSafeEntry('a\\b', 1), /backslash/)
  assert.doesNotThrow(() => assertSafeEntry('a/b.txt', 1))
})

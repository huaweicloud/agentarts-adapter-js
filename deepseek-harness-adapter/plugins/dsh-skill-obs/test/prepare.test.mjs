import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { zipSync } from 'fflate'

import { prepareAll, extractZip } from '../src/prepare.js'
import { parseSkillRefs } from '../src/config.js'

const SKILL_MD = `---
name: json-processor
description: 对 JSON 数据进行格式化。When to use: 用户要求格式化 JSON 时使用。
---

# JSON Processor
`

function makeZip(name = 'json-processor', content = SKILL_MD) {
  return zipSync({ [`${name}/SKILL.md`]: Buffer.from(content) })
}

async function serveZip(zip) {
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/missing.zip')) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'application/zip' })
    res.end(Buffer.from(zip))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, endpoint: `http://127.0.0.1:${server.address().port}` }
}

function configFor(endpoint, mountDir, skills) {
  return {
    enabled: true,
    mountDir,
    skills,
    userBucket: 'bucket-a',
    region: 'cn-southwest-2',
    endpoint,
    forceRefresh: true,
  }
}

test('parseSkillRefs parses id:name:version lists with spaces', () => {
  assert.deepEqual(parseSkillRefs('id-1:json-processor:v1, id-2:markdown-formatter:v1'), [
    { id: 'id-1', name: 'json-processor', version: 'v1' },
    { id: 'id-2', name: 'markdown-formatter', version: 'v1' },
  ])
  assert.deepEqual(parseSkillRefs('D:\\temp\\local-skills'), [])
})

test('prepareAll downloads, force-refreshes, deletes the zip and fixes frontmatter', async () => {
  const zip = makeZip()
  const { server, endpoint } = await serveZip(zip)
  const mountDir = mkdtempSync(join(tmpdir(), 'skill-obs-'))
  try {
    const target = join(mountDir, 'json-processor')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'stale.txt'), 'stale')

    const summary = await prepareAll(configFor(endpoint, mountDir, 'id-1:json-processor:v1'))
    assert.equal(summary.items.length, 1)
    assert.equal(summary.items[0].ok, true)
    assert.equal(summary.dirs[0], mountDir)
    // Force refresh removed the stale file.
    assert.equal(existsSync(join(target, 'stale.txt')), false)
    // Frontmatter description was quoted automatically.
    const repaired = readFileSync(join(target, 'SKILL.md'), 'utf8')
    assert.match(repaired, /description: "/)
    assert.deepEqual(summary.items[0].fixed, ['description quoted'])
    // No downloaded archive is left behind.
    assert.equal(readdirSync(mountDir).some((name) => name.endsWith('.zip')), false)
  } finally {
    server.close()
    rmSync(mountDir, { recursive: true, force: true })
  }
})

test('prepareAll reports download failures per skill without aborting others', async () => {
  const zip = makeZip()
  const { server, endpoint } = await serveZip(zip)
  const mountDir = mkdtempSync(join(tmpdir(), 'skill-obs-'))
  try {
    const summary = await prepareAll(
      configFor(endpoint, mountDir, 'id-1:json-processor:v1, id-2:missing:v1'),
    )
    assert.equal(summary.items.length, 2)
    assert.equal(summary.items[0].ok, true)
    assert.equal(summary.items[1].ok, false)
    assert.match(summary.items[1].error, /HTTP 404/)
    assert.equal(summary.warnings.length, 1)
  } finally {
    server.close()
    rmSync(mountDir, { recursive: true, force: true })
  }
})

test('extractZip supports root-level SKILL.md by placing it under the skill name', () => {
  const mountDir = mkdtempSync(join(tmpdir(), 'skill-obs-'))
  try {
    const zip = zipSync({ 'SKILL.md': Buffer.from(SKILL_MD) })
    const dir = extractZip(Buffer.from(zip), { name: 'json-processor' }, mountDir)
    assert.equal(dir, join(mountDir, 'json-processor'))
    assert.equal(existsSync(join(dir, 'SKILL.md')), true)
  } finally {
    rmSync(mountDir, { recursive: true, force: true })
  }
})

test('extractZip rejects zips without SKILL.md', () => {
  const zip = zipSync({ 'readme.txt': Buffer.from('nothing') })
  assert.throws(() => extractZip(Buffer.from(zip), { name: 'x' }, tmpdir()), /no SKILL.md/)
})

test('forceRefresh=false reuses a valid cached skill without downloading again', async () => {
  const zip = makeZip()
  const { server, endpoint } = await serveZip(zip)
  const mountDir = mkdtempSync(join(tmpdir(), 'skill-obs-'))
  try {
    // First launch downloads the skill.
    const first = await prepareAll(configFor(endpoint, mountDir, 'id-1:json-processor:v1'))
    assert.equal(first.items[0].ok, true)
    // Second launch with forceRefresh=false must not hit the network at all.
    const fetchImpl = async () => {
      throw new Error('network should not be called for a valid cache')
    }
    const cachedConfig = { ...configFor(endpoint, mountDir, 'id-1:json-processor:v1'), forceRefresh: false }
    const summary = await prepareAll(cachedConfig, { env: {}, fetchImpl })
    assert.equal(summary.items[0].ok, true)
    assert.equal(summary.items[0].cached, true)
    assert.equal(summary.items[0].dir, join(mountDir, 'json-processor'))
  } finally {
    server.close()
    rmSync(mountDir, { recursive: true, force: true })
  }
})

test('forceRefresh=false re-downloads when the cached frontmatter is invalid', async () => {
  const zip = makeZip()
  const { server, endpoint } = await serveZip(zip)
  const mountDir = mkdtempSync(join(tmpdir(), 'skill-obs-'))
  try {
    const cachedConfig = { ...configFor(endpoint, mountDir, 'id-1:json-processor:v1'), forceRefresh: false }
    const target = join(mountDir, 'json-processor')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), 'no frontmatter here')
    const summary = await prepareAll(cachedConfig)
    assert.equal(summary.items[0].ok, true)
    assert.notEqual(summary.items[0].cached, true)
    assert.match(readFileSync(join(target, 'SKILL.md'), 'utf8'), /description: "/)
  } finally {
    server.close()
    rmSync(mountDir, { recursive: true, force: true })
  }
})

test('default (forceRefresh unset) reuses the cache and skips the second download', async () => {
  const zip = makeZip()
  const { server, endpoint } = await serveZip(zip)
  const mountDir = mkdtempSync(join(tmpdir(), 'skill-obs-'))
  try {
    const config = configFor(endpoint, mountDir, 'id-1:json-processor:v1')
    // First launch downloads (explicitly forced to simulate a cold start).
    const first = await prepareAll({ ...config, forceRefresh: true })
    assert.equal(first.items[0].ok, true)
    // Second launch without forceRefresh: default is to reuse the cache, so fetch must not run.
    delete config.forceRefresh
    const fetchImpl = async () => {
      throw new Error('default cache path should not download')
    }
    const summary = await prepareAll(config, { env: {}, fetchImpl })
    assert.equal(summary.items[0].ok, true)
    assert.equal(summary.items[0].cached, true)
  } finally {
    server.close()
    rmSync(mountDir, { recursive: true, force: true })
  }
})

test('prepareAll uses the official ObsClient for the real OBS endpoint', async () => {
  const zip = makeZip()
  const mountDir = mkdtempSync(join(tmpdir(), 'skill-obs-'))
  const calls = []
  const fakeClient = {
    async getObject(params) {
      calls.push(params)
      // ObsClient writes the binary to params.SaveAsFile (avoids UTF-8 string corruption).
      writeFileSync(params.SaveAsFile, Buffer.from(zip))
      return { CommonMsg: { Status: 200 } }
    },
  }
  const obsClientFactory = (credentials, endpoint) => {
    calls.push({ credentials, endpoint })
    return fakeClient
  }
  try {
    const config = {
      ...configFor('', mountDir, 'id-1:json-processor:v1'),
      obsEndpoint: 'https://obs.cn-southwest-2.myhuaweicloud.com',
    }
    const summary = await prepareAll(config, {
      credentialFactory: async () => ({ ak: 'A', sk: 'S', securityToken: 'T' }),
      obsClientFactory,
    })
    assert.equal(summary.items[0].ok, true)
    const clientArgs = calls.find((call) => call.credentials)
    assert.deepEqual(clientArgs.credentials, { ak: 'A', sk: 'S', stsToken: 'T' })
    assert.equal(clientArgs.endpoint, 'https://obs.cn-southwest-2.myhuaweicloud.com')
    const getCall = calls.find((call) => call.Bucket)
    assert.equal(getCall.Bucket, 'bucket-a')
    assert.equal(getCall.Key, 'agentarts/skills/id-1/json-processor.zip')
    assert.match(getCall.SaveAsFile, /\.download-json-processor-.*\.zip$/)
  } finally {
    rmSync(mountDir, { recursive: true, force: true })
  }
})

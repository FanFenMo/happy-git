import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPublicConfig, verifyAuthorizationService, writeNativeConfigs } from '../scripts/prepare-config.mjs'

const releaseDir = fileURLToPath(new URL('../release/', import.meta.url))
fs.mkdirSync(releaseDir, { recursive: true })
function fixture(config = {}) {
  const rootDir = fs.mkdtempSync(path.join(releaseDir, 'public-config-'))
  fs.writeFileSync(path.join(rootDir, 'public-config.json'), JSON.stringify(config))
  return rootDir
}

test('release refuses empty and device-local service addresses', () => {
  const rootDir = fixture()
  assert.throws(() => readPublicConfig({ rootDir, env: {}, release: true }), /缺少授权服务地址/)
  for (const url of ['http://localhost:8081', 'https://localhost', 'https://127.0.0.1', 'https://10.0.2.2']) {
    assert.throws(() => readPublicConfig({ rootDir, env: { VITE_API_BASE_URL: url }, release: true }))
  }
  assert.equal(readPublicConfig({ rootDir, env: { VITE_API_BASE_URL: 'http://127.0.0.1:8081' } }).apiBaseUrl, 'http://127.0.0.1:8081')
})

test('one public manifest configures both clients without exposing server secrets', () => {
  const rootDir = fixture({ apiBaseUrl: 'https://auth.example.org/', clientSecret: 'excluded-secret' })
  const config = readPublicConfig({ rootDir, env: {}, release: true })
  writeNativeConfigs({ ...config, clientSecret: 'excluded-secret' }, rootDir)
  const electron = fs.readFileSync(path.join(rootDir, 'electron/config.generated.json'), 'utf8')
  const android = fs.readFileSync(path.join(rootDir, 'android/app/src/main/res/values/happygit_config.xml'), 'utf8')
  assert.deepEqual(JSON.parse(electron), { apiBaseUrl: 'https://auth.example.org' })
  assert.ok(android.includes('https://auth.example.org'))
  assert.equal(electron.includes('excluded-secret') || android.includes('excluded-secret'), false)
})

test('production files and CI override the versioned service address', () => {
  const rootDir = fixture({ apiBaseUrl: 'https://default.example.org' })
  fs.writeFileSync(path.join(rootDir, '.env'), 'VITE_API_BASE_URL=https://env.example.org\n')
  fs.writeFileSync(path.join(rootDir, '.env.local'), 'VITE_API_BASE_URL=https://local.example.org\n')
  fs.writeFileSync(path.join(rootDir, '.env.production'), 'VITE_API_BASE_URL=https://production.example.org\n')
  fs.writeFileSync(path.join(rootDir, '.env.production.local'), 'VITE_API_BASE_URL=https://production-local.example.org\n')
  assert.equal(readPublicConfig({ rootDir, env: {}, mode: 'production', release: true }).apiBaseUrl, 'https://production-local.example.org')
  assert.equal(readPublicConfig({ rootDir, env: {}, mode: 'development' }).apiBaseUrl, 'https://local.example.org')
  assert.equal(readPublicConfig({ rootDir, env: { VITE_API_BASE_URL: 'https://ci.example.org' }, release: true }).apiBaseUrl, 'https://ci.example.org')
})

test('release rejects unsafe addresses instead of publishing them', () => {
  const rootDir = fixture()
  for (const url of ['http://auth.example.org', 'https://user:secret@auth.example.org', 'https://auth.example.org?token=secret', 'https://auth.example.org/#fragment']) {
    assert.throws(() => readPublicConfig({ rootDir, env: { VITE_API_BASE_URL: url }, release: true }))
  }
})

test('release verifies the actual authorization service contract', async () => {
  const config = { apiBaseUrl: 'https://auth.example.org' }
  let requested
  await verifyAuthorizationService(config, async (url, options) => {
    requested = { url, options }
    return { ok: true, json: async () => ({ authProtocol: 'github-oauth-web-v1', configured: true }) }
  })
  assert.equal(requested.url, 'https://auth.example.org/api/auth/github/status')
  assert.equal(requested.options.redirect, 'error')
  await assert.rejects(() => verifyAuthorizationService(config, async () => ({ ok: true, json: async () => ({ authProtocol: 'github-oauth-web-v1', configured: false }) })), /未完成/)
  await assert.rejects(() => verifyAuthorizationService(config, async () => ({ ok: true, json: async () => ({ configured: true }) })), /协议版本/)
  await assert.rejects(() => verifyAuthorizationService(config, async () => ({ ok: false, status: 503 })), /503/)
})

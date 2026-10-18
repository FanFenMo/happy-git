const { safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes, createHash } = require('node:crypto')
const { requestGitHub } = require('./github.cjs')

let authDir, apiBaseUrl = '', credentials = null
let contextId = newContext(), status = 'guest', refreshPromise = null
const challenges = new Map()
let authorizationVersion = 0
const newId = () => randomBytes(32).toString('base64url')
function newContext() { return 'ctx_' + randomBytes(16).toString('hex') }
function failure(code, message = code) { return Object.assign(new Error(message), { code }) }
function assertContext(expected) {
  if (expected !== contextId) throw failure('SESSION_CHANGED', '账号已变化，请重新操作')
}
function initAuth(userDataPath, config = {}) {
  authDir = path.join(userDataPath, 'auth')
  fs.mkdirSync(authDir, { recursive: true })
  apiBaseUrl = (config.apiBaseUrl || '').replace(/\/$/, '')
  const file = path.join(authDir, 'credentials.bin')
  if (fs.existsSync(file) && safeStorage.isEncryptionAvailable()) {
    try { credentials = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) }
    catch { credentials = null }
  }
}
function saveCredentials(value) {
  if (!safeStorage.isEncryptionAvailable()) throw failure('STORAGE_UNAVAILABLE', '系统凭据加密不可用，无法保存账号')
  const file = path.join(authDir, 'credentials.bin')
  fs.writeFileSync(file + '.tmp', safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 })
  fs.renameSync(file + '.tmp', file)
  credentials = value
}
function clearCredentials() {
  const file = path.join(authDir, 'credentials.bin')
  if (fs.existsSync(file)) fs.unlinkSync(file)
  for (const id of challenges.keys()) cancelAuthorization(id)
  credentials = null
  status = 'guest'
  contextId = newContext()
}
async function broker(endpoint, body, signal) {
  if (!apiBaseUrl) throw failure('CONFIG_MISSING', '请先配置 GitHub 授权服务地址')
  const url = new URL(apiBaseUrl)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw failure('CONFIG_INVALID', '授权服务必须使用 HTTPS')
  if (url.username || url.password) throw failure('CONFIG_INVALID')
  const response = await fetch(apiBaseUrl + '/api/auth/github/' + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000)
  })
  if (!response.ok) throw failure(response.status === 401 ? 'AUTH_REQUIRED' : 'AUTH_SERVICE_ERROR',
    response.status === 503 ? '服务端尚未配置 GitHub 网页授权' : 'GitHub 授权服务请求失败，请重试')
  return response.json()
}
async function beginAuthorization() {
  const version = ++authorizationVersion
  for (const id of challenges.keys()) cancelAuthorization(id)
  if (!safeStorage.isEncryptionAvailable()) throw failure('STORAGE_UNAVAILABLE', '系统凭据加密不可用，无法保存账号')
  const verifier = newId(), expected = contextId
  const data = await broker('begin', { codeChallenge: createHash('sha256').update(verifier).digest('base64url') })
  assertContext(expected)
  if (version !== authorizationVersion) throw failure('AUTH_CANCELLED')
  const uri = new URL(data.authorizationUrl)
  if (uri.origin !== 'https://github.com' || uri.pathname !== '/login/oauth/authorize') throw failure('AUTH_SERVICE_ERROR', '授权地址无效')
  challenges.set(data.challengeId, { ...data, verifier, expected, controller: new AbortController() })
  return data
}
function profileFrom(raw) {
  return { accountId: String(raw.id), login: raw.login, displayName: raw.name || raw.login,
    avatarUrl: raw.avatar_url || null, profileUrl: raw.html_url, bio: raw.bio || null,
    location: raw.location || null, company: raw.company || null, publicRepoCount: raw.public_repos || 0,
    followerCount: raw.followers || 0, followingCount: raw.following || 0, fetchedAt: Date.now() }
}
function session(profile = null) {
  return { status, accountId: credentials?.accountId || null, contextId, profile, verifiedAt: status === 'authenticated' ? Date.now() : null }
}
async function pollAuthorization(id, callDb) {
  const ch = challenges.get(id)
  if (!ch) return { state: 'cancelled' }
  if (ch.poll) return ch.poll
  const active = () => challenges.get(id) === ch && ch.expected === contextId
  ch.poll = (async () => {
    const data = await broker('poll', { challengeId: id, codeVerifier: ch.verifier }, ch.controller.signal)
    if (!active()) return { state: 'cancelled' }
    if (data.state !== 'authenticated') {
      if (!['pending', 'slowDown'].includes(data.state)) challenges.delete(id)
      return data
    }
    const tokens = data.tokens
    const user = await requestGitHub('currentUser', {}, tokens.access_token)
    if (!active()) return { state: 'cancelled' }
    if (user.status !== 200 || !user.body?.id) throw failure('AUTH_VERIFY_FAILED', '无法验证 GitHub 账号，请重新登录')
    const profile = profileFrom(user.body)
    await callDb('saveProfile', { accountId: profile.accountId, profile })
    if (!active()) return { state: 'cancelled' }
    saveCredentials({ accountId: profile.accountId, accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null })
    contextId = newContext()
    status = 'authenticated'
    challenges.delete(id)
    await callDb('saveSetting', { key: 'mode', value: 'account' })
    return { state: 'authenticated', session: session(profile) }
  })().finally(() => { ch.poll = null })
  return ch.poll
}
function cancelAuthorization(id) {
  if (!id) { authorizationVersion++; for (const key of challenges.keys()) cancelAuthorization(key); return }
  const ch = challenges.get(id)
  if (!ch) return
  challenges.delete(id)
  ch.controller.abort()
  broker('cancel', { challengeId: id, codeVerifier: ch.verifier }).catch(() => {})
}
async function refreshAccessToken(expected) {
  assertContext(expected)
  const original = credentials
  if (!original?.refreshToken) { status = 'reauthRequired'; throw failure('AUTH_REQUIRED', '授权已失效，请重新登录') }
  let tokens
  try { tokens = await broker('refresh', { refreshToken: original.refreshToken }) }
  catch (e) { if (e.code === 'AUTH_REQUIRED' && expected === contextId) status = 'reauthRequired'; throw e }
  assertContext(expected)
  saveCredentials({ ...original, accessToken: tokens.access_token, refreshToken: tokens.refresh_token || original.refreshToken,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null })
}
async function refresh(expected) {
  if (!refreshPromise || refreshPromise.context !== expected) {
    const entry = { context: expected }
    entry.promise = refreshAccessToken(expected).finally(() => { if (refreshPromise === entry) refreshPromise = null })
    refreshPromise = entry
  }
  return refreshPromise.promise
}
async function ensureAccessToken(expected = contextId) {
  assertContext(expected)
  if (!credentials?.accessToken || status === 'reauthRequired') throw failure('AUTH_REQUIRED', '请重新登录 GitHub')
  if (credentials.expiresAt && credentials.expiresAt - Date.now() < 60000) await refresh(expected)
  assertContext(expected)
  return credentials.accessToken
}
async function authorizedRequest(resource, args, expected) {
  let result = await requestGitHub(resource, args, await ensureAccessToken(expected))
  assertContext(expected)
  if (result.status === 401) {
    await refresh(expected)
    result = await requestGitHub(resource, args, await ensureAccessToken(expected))
    assertContext(expected)
    if (result.status === 401) { status = 'reauthRequired'; throw failure('AUTH_REQUIRED', 'GitHub 授权已失效，请重新登录') }
  }
  if (result.status < 400) status = 'authenticated'
  return result
}
async function restoreSession(callDb) {
  if (!credentials?.accountId) return session()
  const expected = contextId
  try {
    const user = await authorizedRequest('currentUser', {}, expected)
    if (user.status === 200) {
      const profile = profileFrom(user.body)
      if (profile.accountId !== credentials.accountId) { status = 'reauthRequired'; throw failure('AUTH_REQUIRED') }
      await callDb('saveProfile', { accountId: profile.accountId, profile })
      assertContext(expected)
      status = 'authenticated'
      return session(profile)
    }
    status = 'offline'
  } catch (e) {
    assertContext(expected)
    if (status !== 'reauthRequired') status = e.code === 'AUTH_REQUIRED' ? 'reauthRequired' : 'offline'
  }
  const snap = await callDb('readAccountSnapshot', { accountId: credentials.accountId })
  assertContext(expected)
  return session(snap?.profile || null)
}
module.exports = { initAuth, beginAuthorization, pollAuthorization, cancelAuthorization, ensureAccessToken,
  authorizedRequest, restoreSession, clearCredentials, assertContext,
  getContextId: () => contextId, getCurrentAccountId: () => credentials?.accountId || null, getStatus: () => status }

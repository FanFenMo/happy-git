/**
 * auth.cjs
 * 运行在 Electron 主进程中，负责 GitHub App Device Flow、凭据安全加解密与会话维护
 */
const { safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { requestGitHub } = require('./github.cjs')

let authDir = null
let currentCredentials = null
let currentContextId = null
let activeChallenges = new Map()
let refreshPromise = null

function initAuth(userDataPath) {
  authDir = path.join(userDataPath, 'auth')
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true })
  }
  currentContextId = 'ctx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
  readStoredCredentials()
}

function getCredentialsPath() {
  return path.join(authDir, 'credentials.bin')
}

function readStoredCredentials() {
  const credPath = getCredentialsPath()
  if (!fs.existsSync(credPath)) {
    currentCredentials = null
    return null
  }
  try {
    const encrypted = fs.readFileSync(credPath)
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(encrypted)
      currentCredentials = JSON.parse(decrypted)
    } else {
      currentCredentials = JSON.parse(encrypted.toString('utf-8'))
    }
    return currentCredentials
  } catch (err) {
    console.warn('[auth.cjs] 读取加密凭据失败:', err)
    currentCredentials = null
    return null
  }
}

function saveCredentials(creds) {
  const credPath = getCredentialsPath()
  const tmpPath = credPath + '.tmp'
  const text = JSON.stringify(creds)
  let dataToWrite
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    dataToWrite = safeStorage.encryptString(text)
  } else {
    dataToWrite = Buffer.from(text, 'utf-8')
  }

  fs.writeFileSync(tmpPath, dataToWrite)
  fs.renameSync(tmpPath, credPath)
  currentCredentials = creds
}

function clearCredentials() {
  const credPath = getCredentialsPath()
  if (fs.existsSync(credPath)) {
    try { fs.unlinkSync(credPath) } catch {}
  }
  currentCredentials = null
  currentContextId = 'ctx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
}

async function beginAuthorization(clientId) {
  if (!clientId) {
    throw new Error('CONFIG_MISSING')
  }

  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      client_id: clientId,
      scope: 'offline_access'
    })
  })

  if (!response.ok) {
    throw new Error(`AUTH_BEGIN_FAILED: ${response.status}`)
  }

  const data = await response.json()
  const challengeId = 'ch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
  const now = Date.now()
  const intervalMs = (data.interval || 5) * 1000

  activeChallenges.set(challengeId, {
    clientId,
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresAt: now + (data.expires_in || 900) * 1000,
    intervalMs,
    nextPollAt: now + intervalMs
  })

  return {
    challengeId,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresAt: now + (data.expires_in || 900) * 1000,
    intervalMs
  }
}

async function pollAuthorization(challengeId, callDb) {
  const ch = activeChallenges.get(challengeId)
  if (!ch) {
    return { state: 'cancelled', nextPollAt: null }
  }

  const now = Date.now()
  if (now > ch.expiresAt) {
    activeChallenges.delete(challengeId)
    return { state: 'expired', nextPollAt: null }
  }

  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: ch.clientId,
        device_code: ch.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    })

    const data = await res.json()

    if (data.error) {
      if (data.error === 'authorization_pending') {
        ch.nextPollAt = now + ch.intervalMs
        return { state: 'pending', nextPollAt: ch.nextPollAt }
      }
      if (data.error === 'slow_down') {
        ch.intervalMs = (data.interval || 10) * 1000
        ch.nextPollAt = now + ch.intervalMs
        return { state: 'slowDown', nextPollAt: ch.nextPollAt }
      }
      if (data.error === 'expired_token') {
        activeChallenges.delete(challengeId)
        return { state: 'expired', nextPollAt: null }
      }
      if (data.error === 'access_denied') {
        activeChallenges.delete(challengeId)
        return { state: 'denied', nextPollAt: null }
      }
      activeChallenges.delete(challengeId)
      return { state: 'cancelled', nextPollAt: null }
    }

    if (data.access_token) {
      activeChallenges.delete(challengeId)

      // 请求真实 /user 验证身份
      const userRes = await requestGitHub('currentUser', {}, data.access_token)
      if (userRes.status !== 200 || !userRes.body) {
        throw new Error('VERIFY_USER_FAILED')
      }

      const rawUser = userRes.body
      const accountId = String(rawUser.id)
      const profile = {
        accountId,
        login: rawUser.login,
        displayName: rawUser.name || rawUser.login,
        avatarUrl: rawUser.avatar_url || null,
        profileUrl: rawUser.html_url || `https://github.com/${rawUser.login}`,
        bio: rawUser.bio || null,
        location: rawUser.location || null,
        company: rawUser.company || null,
        publicRepoCount: rawUser.public_repos || 0,
        followerCount: rawUser.followers || 0,
        followingCount: rawUser.following || 0,
        fetchedAt: Date.now()
      }

      const creds = {
        accountId,
        login: rawUser.login,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || null,
        expiresAt: data.expires_in ? now + data.expires_in * 1000 : null,
        refreshTokenExpiresAt: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1000 : null,
        clientId: ch.clientId
      }

      // 落库账号资料
      await callDb('saveProfile', { accountId, profile })
      // 保存加密凭据
      saveCredentials(creds)
      // 更新全局活动模式
      await callDb('saveSetting', { key: 'mode', value: 'account' })
      await callDb('saveSetting', { key: 'active_account_id', value: accountId })

      currentContextId = 'ctx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)

      return {
        state: 'authenticated',
        nextPollAt: null,
        session: {
          status: 'authenticated',
          accountId,
          contextId: currentContextId,
          profile,
          verifiedAt: Date.now()
        }
      }
    }

    return { state: 'pending', nextPollAt: now + ch.intervalMs }
  } catch (err) {
    console.error('[auth.cjs] 轮询异常:', err)
    return { state: 'pending', nextPollAt: now + ch.intervalMs }
  }
}

function cancelAuthorization(challengeId) {
  activeChallenges.delete(challengeId)
}

async function ensureAccessToken() {
  if (!currentCredentials || !currentCredentials.accessToken) {
    throw new Error('AUTH_REQUIRED')
  }

  const now = Date.now()
  // 若令牌有效期不足 60 秒且存在 refreshToken，执行刷新
  if (currentCredentials.expiresAt && (currentCredentials.expiresAt - now < 60000) && currentCredentials.refreshToken) {
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken().finally(() => {
        refreshPromise = null
      })
    }
    await refreshPromise
  }

  return currentCredentials.accessToken
}

async function refreshAccessToken() {
  if (!currentCredentials || !currentCredentials.refreshToken) {
    throw new Error('CANNOT_REFRESH_TOKEN')
  }

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      client_id: currentCredentials.clientId,
      grant_type: 'refresh_token',
      refresh_token: currentCredentials.refreshToken
    })
  })

  if (!res.ok) {
    throw new Error('REFRESH_TOKEN_FAILED')
  }

  const data = await res.json()
  if (data.error || !data.access_token) {
    throw new Error(data.error || 'REFRESH_TOKEN_FAILED')
  }

  const now = Date.now()
  const updated = {
    ...currentCredentials,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || currentCredentials.refreshToken,
    expiresAt: data.expires_in ? now + data.expires_in * 1000 : null,
    refreshTokenExpiresAt: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1000 : currentCredentials.refreshTokenExpiresAt
  }

  saveCredentials(updated)
}

async function restoreSession(callDb) {
  const creds = readStoredCredentials()
  if (!creds || !creds.accountId) {
    return {
      status: 'guest',
      accountId: null,
      contextId: currentContextId,
      profile: null,
      verifiedAt: null
    }
  }

  // 尝试在线验证
  try {
    const token = await ensureAccessToken()
    const userRes = await requestGitHub('currentUser', {}, token)
    if (userRes.status === 200 && userRes.body) {
      const rawUser = userRes.body
      const accountId = String(rawUser.id)
      const profile = {
        accountId,
        login: rawUser.login,
        displayName: rawUser.name || rawUser.login,
        avatarUrl: rawUser.avatar_url || null,
        profileUrl: rawUser.html_url || `https://github.com/${rawUser.login}`,
        bio: rawUser.bio || null,
        location: rawUser.location || null,
        company: rawUser.company || null,
        publicRepoCount: rawUser.public_repos || 0,
        followerCount: rawUser.followers || 0,
        followingCount: rawUser.following || 0,
        fetchedAt: Date.now()
      }

      await callDb('saveProfile', { accountId, profile })
      return {
        status: 'authenticated',
        accountId,
        contextId: currentContextId,
        profile,
        verifiedAt: Date.now()
      }
    } else if (userRes.status === 401) {
      // 尝试一次刷新
      try {
        await refreshAccessToken()
        const refreshedToken = currentCredentials.accessToken
        const retryRes = await requestGitHub('currentUser', {}, refreshedToken)
        if (retryRes.status === 200 && retryRes.body) {
          const rawUser = retryRes.body
          const accountId = String(rawUser.id)
          const profile = {
            accountId,
            login: rawUser.login,
            displayName: rawUser.name || rawUser.login,
            avatarUrl: rawUser.avatar_url || null,
            profileUrl: rawUser.html_url || `https://github.com/${rawUser.login}`,
            bio: rawUser.bio || null,
            location: rawUser.location || null,
            company: rawUser.company || null,
            publicRepoCount: rawUser.public_repos || 0,
            followerCount: rawUser.followers || 0,
            followingCount: rawUser.following || 0,
            fetchedAt: Date.now()
          }
          await callDb('saveProfile', { accountId, profile })
          return {
            status: 'authenticated',
            accountId,
            contextId: currentContextId,
            profile,
            verifiedAt: Date.now()
          }
        }
      } catch {}
      return {
        status: 'reauthRequired',
        accountId: creds.accountId,
        contextId: currentContextId,
        profile: null,
        verifiedAt: null
      }
    }
  } catch (netErr) {
    console.warn('[auth.cjs] 无法连接 GitHub，尝试离线会话恢复:', netErr.message)
  }

  // 离线恢复：读取本地资料缓存
  try {
    const snap = await callDb('readAccountSnapshot', { accountId: creds.accountId })
    if (snap && snap.profile) {
      return {
        status: 'offline',
        accountId: creds.accountId,
        contextId: currentContextId,
        profile: snap.profile,
        verifiedAt: snap.profile.fetchedAt || null
      }
    }
  } catch {}

  return {
    status: 'guest',
    accountId: null,
    contextId: currentContextId,
    profile: null,
    verifiedAt: null
  }
}

module.exports = {
  initAuth,
  beginAuthorization,
  pollAuthorization,
  cancelAuthorization,
  ensureAccessToken,
  restoreSession,
  clearCredentials,
  getContextId: () => currentContextId,
  getCurrentAccountId: () => currentCredentials?.accountId || null
}

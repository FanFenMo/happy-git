/**
 * client/electron/cloud-service.cjs
 * 云端应用会话、安全凭据存储、设备流注册、event_outbox 批量上传与集合快照同步服务
 */

const crypto = require('node:crypto')
let electronSafeStorage = null
let electronShell = null
try {
  const electron = require('electron')
  electronSafeStorage = electron.safeStorage || null
  electronShell = electron.shell || null
} catch (_) {}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

class CloudService {
  constructor({ database, fetchImpl = globalThis.fetch, defaultBaseUrl = null }) {
    this.database = database
    this.fetchImpl = fetchImpl
    this.defaultBaseUrl =
      defaultBaseUrl ||
      process.env.HAPPYGIT_CLOUD_BASE_URL ||
      process.env.HAPPYGIT_SERVER_URL ||
      'http://127.0.0.1:8080'
    this.authChallenges = new Map() // challengeId -> { challengeId, codeVerifier, authorizeUrl, expiresAt, accountId }
    this.flushingAccounts = new Set()
  }

  async getBaseUrl() {
    const customUrl = await this.database.callDatabase('readSetting', { key: 'cloud_base_url' })
    const raw = (typeof customUrl === 'string' && customUrl.trim()) ? customUrl.trim() : this.defaultBaseUrl
    return raw.replace(/\/+$/g, '')
  }

  async getLocalCipherKey() {
    let secret = await this.database.callDatabase('readSetting', { key: 'cloud_local_cipher_seed' })
    if (!secret || typeof secret !== 'string') {
      secret = crypto.randomBytes(32).toString('hex')
      await this.database.callDatabase('saveSetting', { key: 'cloud_local_cipher_seed', value: secret })
    }
    return crypto.createHash('sha256').update(secret, 'utf8').digest()
  }

  async encryptCredentialPayload(payloadObj) {
    const plain = JSON.stringify(payloadObj)
    if (electronSafeStorage && typeof electronSafeStorage.isEncryptionAvailable === 'function' && electronSafeStorage.isEncryptionAvailable()) {
      const encrypted = electronSafeStorage.encryptString(plain)
      return { scheme: 'safeStorage', data: encrypted.toString('base64') }
    }
    const key = await this.getLocalCipherKey()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      scheme: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: enc.toString('base64')
    }
  }

  async decryptCredentialPayload(envelope) {
    if (!envelope || typeof envelope !== 'object' || !envelope.data) return null
    try {
      if (envelope.scheme === 'safeStorage' && electronSafeStorage) {
        const plain = electronSafeStorage.decryptString(Buffer.from(envelope.data, 'base64'))
        return JSON.parse(plain)
      }
      if (envelope.scheme === 'aes-256-gcm') {
        const key = await this.getLocalCipherKey()
        const decipher = crypto.createDecipheriv(
          'aes-256-gcm',
          key,
          Buffer.from(envelope.iv, 'base64')
        )
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
        const dec = Buffer.concat([
          decipher.update(Buffer.from(envelope.data, 'base64')),
          decipher.final()
        ])
        return JSON.parse(dec.toString('utf8'))
      }
    } catch (_) {
      return null
    }
    return null
  }

  async saveTokens(accountId, tokenRecord) {
    const encrypted = await this.encryptCredentialPayload(tokenRecord)
    await this.database.callDatabase('saveSetting', {
      key: `cloud_tokens:${accountId}`,
      value: encrypted
    })
  }

  async readTokens(accountId) {
    if (!accountId) return null
    const envelope = await this.database.callDatabase('readSetting', {
      key: `cloud_tokens:${accountId}`
    })
    return this.decryptCredentialPayload(envelope)
  }

  async clearTokens(accountId) {
    if (!accountId) return
    await this.database.callDatabase('saveSetting', {
      key: `cloud_tokens:${accountId}`,
      value: null
    })
  }

  async requestJson(path, { method = 'GET', token = null, body = undefined } = {}) {
    const baseUrl = await this.getBaseUrl()
    const headers = { Accept: 'application/json' }
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    let response
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      })
    } catch (err) {
      const netErr = new Error(`NETWORK_UNAVAILABLE: ${err.message}`)
      netErr.code = 'NETWORK_UNAVAILABLE'
      throw netErr
    }

    let json = {}
    try {
      const text = await response.text()
      json = text ? JSON.parse(text) : {}
    } catch (_) {}

    if (!response.ok) {
      const errCode = json?.error?.code || json?.code || `HTTP_${response.status}`
      const errMsg = json?.error?.message || json?.message || `Cloud API HTTP ${response.status}`
      const apiErr = new Error(errMsg)
      apiErr.code = errCode
      apiErr.status = response.status
      apiErr.details = json
      throw apiErr
    }

    return json
  }

  async getValidAccessToken(accountId) {
    const tokens = await this.readTokens(accountId)
    if (!tokens || !tokens.accessToken) {
      return null
    }
    const now = Date.now()
    if (tokens.expiresAt && tokens.expiresAt > now + 30000) {
      return tokens.accessToken
    }
    if (!tokens.refreshToken) {
      return null
    }
    try {
      const refreshed = await this.requestJson('/api/v2/session/refresh', {
        method: 'POST',
        body: { refreshToken: tokens.refreshToken }
      })
      const updated = {
        ...tokens,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || tokens.refreshToken,
        expiresAt: refreshed.expiresAt || (now + 3600000),
        subjectId: refreshed.subjectId || tokens.subjectId,
        cloudAccountId: String(refreshed.accountId || tokens.cloudAccountId || accountId)
      }
      await this.saveTokens(accountId, updated)
      await this.database.callDatabase('saveCloudAccountState', {
        accountId,
        patch: {
          subjectId: updated.subjectId,
          cloudAccountId: updated.cloudAccountId,
          cloudBound: String(updated.cloudAccountId) === String(accountId),
          sessionExpiresAt: updated.expiresAt
        }
      })
      return updated.accessToken
    } catch (err) {
      if (err.status === 401 || err.code === 'AUTH_REQUIRED') {
        await this.clearTokens(accountId)
        await this.database.callDatabase('saveCloudAccountState', {
          accountId,
          patch: { cloudBound: false, sessionExpiresAt: null }
        })
      }
      return null
    }
  }

  async beginAuth(context, payload = {}) {
    if (!context || !context.accountId) {
      const err = new Error('请先在本地登录 GitHub 账号后再绑定云端分析会话')
      err.code = 'AUTH_REQUIRED'
      throw err
    }
    const codeVerifier = base64UrlEncode(crypto.randomBytes(32))
    const codeChallenge = base64UrlEncode(
      crypto.createHash('sha256').update(codeVerifier, 'utf8').digest()
    )

    const res = await this.requestJson('/api/v2/auth/github/begin', {
      method: 'POST',
      body: { codeChallenge }
    })

    const challengeRecord = {
      challengeId: res.challengeId,
      codeVerifier,
      authorizeUrl: res.authorizeUrl,
      expiresAt: res.expiresAt,
      accountId: context.accountId
    }
    this.authChallenges.set(res.challengeId, challengeRecord)

    if (payload.openBrowser !== false && res.authorizeUrl && electronShell) {
      try {
        await electronShell.openExternal(res.authorizeUrl)
      } catch (_) {}
    }

    return {
      challengeId: res.challengeId,
      authorizeUrl: res.authorizeUrl,
      expiresAt: res.expiresAt,
      state: 'pending'
    }
  }

  async pollAuth(context, { challengeId } = {}) {
    const ch = this.authChallenges.get(challengeId)
    if (!ch) {
      return { state: 'failed', error: { code: 'CHALLENGE_NOT_FOUND', message: '登录挑战不存在或已过期' } }
    }

    const res = await this.requestJson('/api/v2/auth/github/poll', {
      method: 'POST',
      body: {
        challengeId,
        codeVerifier: ch.codeVerifier
      }
    })

    if (res.state !== 'authenticated') {
      return {
        challengeId,
        state: res.state || 'pending'
      }
    }

    this.authChallenges.delete(challengeId)
    const localAccountId = context.accountId || ch.accountId
    const cloudAccountId = String(res.accountId || localAccountId)

    // 严格核对本地 GitHub 账号与云端认证账号一致性
    if (localAccountId && cloudAccountId !== String(localAccountId)) {
      await this.database.callDatabase('saveCloudAccountState', {
        accountId: localAccountId,
        patch: {
          subjectId: res.subjectId || null,
          cloudAccountId,
          cloudBound: false,
          sessionExpiresAt: null
        }
      })
      return {
        challengeId,
        state: 'account_mismatch',
        error: {
          code: 'CLOUD_ACCOUNT_MISMATCH',
          message: `云端授权的 GitHub 账号 (${cloudAccountId}) 与当前客户端登录账号 (${localAccountId}) 不一致，已阻止行为上传`
        }
      }
    }

    await this.saveTokens(localAccountId, {
      accessToken: res.accessToken,
      refreshToken: res.refreshToken,
      expiresAt: res.expiresAt,
      subjectId: res.subjectId,
      cloudAccountId
    })

    await this.database.callDatabase('saveCloudAccountState', {
      accountId: localAccountId,
      patch: {
        subjectId: res.subjectId,
        cloudAccountId,
        cloudBound: true,
        sessionExpiresAt: res.expiresAt
      }
    })

    await this.registerDeviceAndSyncStream(localAccountId)
    await this.flushOutbox({ accountId: localAccountId, status: 'authenticated' })
    await this.syncCollections({ accountId: localAccountId, status: 'authenticated' })

    const syncState = await this.database.callDatabase('readCloudSyncState', { accountId: localAccountId })
    return {
      challengeId,
      state: 'authenticated',
      cloudSync: syncState
    }
  }

  cancelAuth({ challengeId } = {}) {
    if (challengeId) {
      this.authChallenges.delete(challengeId)
    }
    return { cancelled: true }
  }

  async restoreSession(context) {
    if (!context || !context.accountId) {
      return { state: 'unbound', cloudSync: null }
    }
    const accountId = context.accountId
    const token = await this.getValidAccessToken(accountId)
    if (!token) {
      const syncState = await this.database.callDatabase('readCloudSyncState', { accountId })
      return { state: 'unbound', cloudSync: syncState }
    }

    const tokens = await this.readTokens(accountId)
    if (tokens?.cloudAccountId && String(tokens.cloudAccountId) !== String(accountId)) {
      await this.database.callDatabase('saveCloudAccountState', {
        accountId,
        patch: { cloudBound: false, cloudAccountId: String(tokens.cloudAccountId) }
      })
      return {
        state: 'account_mismatch',
        cloudSync: await this.database.callDatabase('readCloudSyncState', { accountId })
      }
    }

    try {
      await this.registerDeviceAndSyncStream(accountId)
      const syncState = await this.database.callDatabase('readCloudSyncState', { accountId })
      return { state: 'authenticated', cloudSync: syncState }
    } catch (err) {
      const syncState = await this.database.callDatabase('readCloudSyncState', { accountId })
      return {
        state: err.code === 'NETWORK_UNAVAILABLE' ? 'offline' : 'authenticated',
        cloudSync: syncState
      }
    }
  }

  async logoutSession(context) {
    if (!context || !context.accountId) return { loggedOut: true }
    const accountId = context.accountId
    const tokens = await this.readTokens(accountId)
    if (tokens?.refreshToken) {
      try {
        await this.requestJson('/api/v2/session/logout', {
          method: 'POST',
          token: tokens.accessToken,
          body: { refreshToken: tokens.refreshToken }
        })
      } catch (_) {}
    }
    await this.clearTokens(accountId)
    const cloudSync = await this.database.callDatabase('saveCloudAccountState', {
      accountId,
      patch: {
        cloudBound: false,
        sessionExpiresAt: null
      }
    })
    return { loggedOut: true, cloudSync }
  }

  async registerDeviceAndSyncStream(accountId) {
    const token = await this.getValidAccessToken(accountId)
    if (!token) {
      const err = new Error('CLOUD_AUTH_REQUIRED')
      err.code = 'CLOUD_AUTH_REQUIRED'
      throw err
    }
    const localState = await this.database.callDatabase('readCloudSyncState', { accountId })
    const res = await this.requestJson('/api/v2/devices/register', {
      method: 'POST',
      token,
      body: {
        installationId: localState.installationId
      }
    })
    return this.database.callDatabase('syncCloudStreamState', {
      accountId,
      serverState: res
    })
  }

  async flushOutbox(context) {
    if (!context || !context.accountId) {
      return { flushed: false, reason: 'NO_ACTIVE_ACCOUNT' }
    }
    const accountId = context.accountId
    if (this.flushingAccounts.has(accountId)) {
      return {
        flushed: false,
        reason: 'ALREADY_FLUSHING',
        cloudSync: await this.database.callDatabase('readCloudSyncState', { accountId })
      }
    }

    this.flushingAccounts.add(accountId)
    try {
      let state = await this.database.callDatabase('readCloudSyncState', { accountId })
      if (!state || !state.cloudBound) {
        return { flushed: false, reason: 'CLOUD_UNBOUND', cloudSync: state }
      }
      if (!state.accountMatched) {
        return { flushed: false, reason: 'CLOUD_ACCOUNT_MISMATCH', cloudSync: state }
      }
      if (!state.analysisEnabled) {
        return { flushed: false, reason: 'ANALYSIS_DISABLED', cloudSync: state }
      }

      const token = await this.getValidAccessToken(accountId)
      if (!token) {
        return {
          flushed: false,
          reason: 'CLOUD_AUTH_REQUIRED',
          cloudSync: await this.database.callDatabase('readCloudSyncState', { accountId })
        }
      }

      if (!state.deviceId) {
        state = await this.registerDeviceAndSyncStream(accountId)
      }

      let batchesSent = 0
      let eventsAcked = 0
      let realignedOnce = false

      while (true) {
        const batch = await this.database.callDatabase('readOutboxBatch', {
          accountId,
          maxItems: 500,
          maxBytes: 1048576
        })
        if (!batch || !batch.hasBatch || !batch.events?.length) {
          break
        }

        try {
          const ack = await this.requestJson('/api/v2/events/batches', {
            method: 'POST',
            token,
            body: {
              requestId: batch.requestId,
              streamEpoch: batch.streamEpoch,
              analysisEpoch: batch.analysisEpoch,
              firstSeq: batch.firstSeq,
              events: batch.events
            }
          })
          state = await this.database.callDatabase('applyOutboxAck', {
            accountId,
            ackPayload: ack
          })
          batchesSent += 1
          eventsAcked += batch.events.length
        } catch (err) {
          if (
            !realignedOnce &&
            (err.code === 'STREAM_EPOCH_MISMATCH' ||
              err.code === 'ANALYSIS_EPOCH_MISMATCH' ||
              err.code === 'SEQUENCE_GAP')
          ) {
            realignedOnce = true
            state = await this.registerDeviceAndSyncStream(accountId)
            continue
          }
          const retryAt = Date.now() + 30000
          state = await this.database.callDatabase('recordOutboxError', {
            accountId,
            errorCode: err.code || 'UPLOAD_FAILED',
            retryAt
          })
          return {
            flushed: false,
            batchesSent,
            eventsAcked,
            error: { code: err.code || 'UPLOAD_FAILED', message: err.message },
            cloudSync: state
          }
        }
      }

      return {
        flushed: true,
        batchesSent,
        eventsAcked,
        cloudSync: await this.database.callDatabase('readCloudSyncState', { accountId })
      }
    } finally {
      this.flushingAccounts.delete(accountId)
    }
  }

  async syncCollections(context, kinds = ['stars', 'owned']) {
    if (!context || !context.accountId) {
      return { synced: false, reason: 'NO_ACTIVE_ACCOUNT' }
    }
    const accountId = context.accountId
    const state = await this.database.callDatabase('readCloudSyncState', { accountId })
    if (!state || !state.cloudBound || !state.accountMatched || !state.analysisEnabled) {
      return { synced: false, reason: 'CLOUD_NOT_READY', cloudSync: state }
    }

    const token = await this.getValidAccessToken(accountId)
    if (!token) {
      return { synced: false, reason: 'CLOUD_AUTH_REQUIRED', cloudSync: state }
    }

    const results = {}
    for (const collectionKind of kinds) {
      if (collectionKind !== 'stars' && collectionKind !== 'owned') continue
      const prep = await this.database.callDatabase('readCollectionForCloudSync', {
        accountId,
        collectionKind
      })
      if (!prep || !prep.shouldUpload) {
        results[collectionKind] = { uploaded: false, reason: prep?.reason || 'SKIPPED' }
        continue
      }

      try {
        const res = await this.requestJson('/api/v2/me/collections', {
          method: 'PUT',
          token,
          body: {
            operationId: prep.operationId,
            expectedRevision: prep.expectedRevision,
            analysisEpoch: prep.analysisEpoch,
            collectionKind: prep.collectionKind,
            complete: prep.complete,
            observedAt: prep.observedAt,
            repoIds: prep.repoIds
          }
        })
        await this.database.callDatabase('markCollectionCloudSynced', {
          accountId,
          collectionKind,
          result: {
            revision: res.revision,
            complete: true,
            snapshotHash: prep.snapshotHash,
            operationId: prep.operationId
          }
        })
        results[collectionKind] = {
          uploaded: true,
          revision: res.revision,
          itemCount: prep.repoIds.length
        }
      } catch (err) {
        results[collectionKind] = {
          uploaded: false,
          error: { code: err.code || 'COLLECTION_SYNC_FAILED', message: err.message }
        }
      }
    }

    return {
      synced: true,
      results,
      cloudSync: await this.database.callDatabase('readCloudSyncState', { accountId })
    }
  }

  async savePreferences(context, payload = {}) {
    if (!context || !context.accountId) {
      throw new Error('AUTH_REQUIRED')
    }
    const accountId = context.accountId
    await this.database.callDatabase('savePreferences', {
      accountId,
      preferences: payload
    })

    if (typeof payload.analysisEnabled === 'boolean') {
      const state = await this.database.callDatabase('readCloudSyncState', { accountId })
      if (state?.cloudBound && state?.accountMatched) {
        const token = await this.getValidAccessToken(accountId)
        if (token) {
          try {
            const res = await this.requestJson('/api/v2/me/preferences', {
              method: 'PUT',
              token,
              body: {
                operationId: `pref_${accountId}_${Date.now()}`,
                analysisEnabled: payload.analysisEnabled
              }
            })
            if (res.analysisEpoch != null) {
              await this.database.callDatabase('syncCloudStreamState', {
                accountId,
                serverState: {
                  streamEpoch: state.streamEpoch,
                  analysisEpoch: res.analysisEpoch,
                  acceptedThrough: state.acceptedThrough,
                  exportedThrough: state.exportedThrough,
                  processedThrough: state.processedThrough
                }
              })
            }
          } catch (_) {}
        }
      }
    }

    return {
      saved: true,
      cloudSync: await this.database.callDatabase('readCloudSyncState', { accountId })
    }
  }

  async resetAnalysis(context) {
    if (!context || !context.accountId) {
      throw new Error('AUTH_REQUIRED')
    }
    const accountId = context.accountId
    let state = await this.database.callDatabase('readCloudSyncState', { accountId })
    let nextAnalysisEpoch = (state?.analysisEpoch || 1) + 1

    if (state?.cloudBound && state?.accountMatched) {
      const token = await this.getValidAccessToken(accountId)
      if (token) {
        try {
          const res = await this.requestJson('/api/v2/me/analysis/reset', {
            method: 'POST',
            token,
            body: {
              operationId: `reset_${accountId}_${Date.now()}`
            }
          })
          if (res.analysisEpoch != null) {
            nextAnalysisEpoch = Number(res.analysisEpoch)
          }
        } catch (_) {}
      }
    }

    state = await this.database.callDatabase('resetCloudAnalysisLocalState', {
      accountId,
      newAnalysisEpoch: nextAnalysisEpoch
    })

    // 若仍存在需上传的 discard 墓碑，尝试立即冲洗
    try {
      await this.flushOutbox(context)
    } catch (_) {}

    return {
      reset: true,
      analysisEpoch: nextAnalysisEpoch,
      cloudSync: await this.database.callDatabase('readCloudSyncState', { accountId })
    }
  }
}

module.exports = {
  CloudService
}

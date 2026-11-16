/**
 * shared/contracts/index.js
 * 统一数据契约、操作名、会话状态与错误码 (依据 project.md 第四节及阶段二云端协同契约)
 */

export const SESSION_STATUS = {
  GUEST: 'guest',
  RESTORING: 'restoring',
  AUTHENTICATED: 'authenticated',
  OFFLINE: 'offline',
  REAUTH_REQUIRED: 'reauth_required',
  LOGGING_OUT: 'logging_out'
}

export const CLOUD_SESSION_STATUS = {
  UNBOUND: 'unbound',
  AUTHORIZING: 'authorizing',
  AUTHENTICATED: 'authenticated',
  ACCOUNT_MISMATCH: 'account_mismatch',
  EXPIRED: 'expired',
  OFFLINE: 'offline',
  ERROR: 'error'
}

export const ERROR_CODES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  SESSION_CHANGED: 'SESSION_CHANGED',
  NETWORK_UNAVAILABLE: 'NETWORK_UNAVAILABLE',
  PAGE_TIMEOUT: 'PAGE_TIMEOUT',
  PAGE_CONTRACT_CHANGED: 'PAGE_CONTRACT_CHANGED',
  RATE_LIMITED: 'RATE_LIMITED',
  PAGINATION_STALLED: 'PAGINATION_STALLED',
  STAR_STATE_UNCERTAIN: 'STAR_STATE_UNCERTAIN',
  LOCAL_STORAGE_FAILED: 'LOCAL_STORAGE_FAILED',
  INPUT_CHANGED: 'INPUT_CHANGED',
  CLOUD_AUTH_REQUIRED: 'CLOUD_AUTH_REQUIRED',
  CLOUD_ACCOUNT_MISMATCH: 'CLOUD_ACCOUNT_MISMATCH',
  STREAM_EPOCH_MISMATCH: 'STREAM_EPOCH_MISMATCH',
  ANALYSIS_EPOCH_MISMATCH: 'ANALYSIS_EPOCH_MISMATCH',
  SEQUENCE_GAP: 'SEQUENCE_GAP',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  COLLECTION_REVISION_CONFLICT: 'COLLECTION_REVISION_CONFLICT'
}

export const OPERATIONS = {
  APP_INITIALIZE: 'app.initialize',
  SESSION_BEGIN_LOGIN: 'session.beginLogin',
  SESSION_GET_LOGIN_TASK: 'session.getLoginTask',
  SESSION_CANCEL_LOGIN: 'session.cancelLogin',
  SESSION_RESTORE: 'session.restore',
  SESSION_LOGOUT: 'session.logout',
  ACCOUNT_READ_SNAPSHOT: 'account.readSnapshot',
  ACCOUNT_SYNC: 'account.sync',
  TASKS_READ: 'tasks.read',
  TASKS_CANCEL: 'tasks.cancel',
  REPOSITORIES_LIST: 'repositories.list',
  STARS_READ_STATE: 'stars.readState',
  STARS_SET: 'stars.set',
  HISTORY_RECORD: 'history.record',
  HISTORY_LIST: 'history.list',
  HISTORY_DELETE: 'history.delete',
  HISTORY_CLEAR: 'history.clear',
  ACCOUNT_SAVE_PREFERENCES: 'account.savePreferences',
  ACCOUNT_FORGET_LOCAL_DATA: 'account.forgetLocalData',
  DISCOVERY_REFRESH: 'discovery.refresh',
  DISCOVERY_READ: 'discovery.read',
  RECOMMENDATION_CREATE_SNAPSHOT: 'recommendation.createSnapshot',
  RECOMMENDATION_COMMIT: 'recommendation.commit',
  RECOMMENDATION_LIST: 'recommendation.list',
  RECOMMENDATION_FEEDBACK: 'recommendation.feedback',
  REPOSITORY_OPEN: 'repository.open',
  // 第一轮新增：云端应用会话、按次事件上传与兴趣分析控制契约
  CLOUD_AUTH_BEGIN: 'cloud.auth.begin',
  CLOUD_AUTH_POLL: 'cloud.auth.poll',
  CLOUD_AUTH_CANCEL: 'cloud.auth.cancel',
  CLOUD_SESSION_RESTORE: 'cloud.session.restore',
  CLOUD_SESSION_LOGOUT: 'cloud.session.logout',
  CLOUD_SYNC_READ_STATE: 'cloud.sync.readState',
  CLOUD_SYNC_FLUSH: 'cloud.sync.flush',
  CLOUD_PREFERENCES_SAVE: 'cloud.preferences.save',
  CLOUD_ANALYSIS_RESET: 'cloud.analysis.reset',
  CLOUD_COLLECTIONS_SYNC: 'cloud.collections.sync'
}

export const MODEL_VERSION = 'content-v1'
export const PARSER_VERSION = 'content-v1'
export const EVENT_SCHEMA_VERSION = '1.0.0'
export const BROWSE_DEDUP_WINDOW_MS = 30000
export const OUTBOX_MAX_BATCH_SIZE = 500
export const OUTBOX_MAX_BATCH_BYTES = 1048576

export function createSuccessResult(data, contextId = '') {
  return { ok: true, data, contextId }
}

export function createErrorResult(code, message, extra = {}, contextId = '') {
  return {
    ok: false,
    error: {
      code,
      message,
      ...extra
    },
    contextId
  }
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

function rotr(n, x) {
  return (x >>> n) | (x << (32 - n))
}

/**
 * 跨环境确定性 UTF-8 SHA-256 小写十六进制摘要
 */
export function sha256HexUtf8(input) {
  const bytes = new TextEncoder().encode(String(input))
  const bitLen = bytes.length * 8
  const totalBytes = (((bytes.length + 8) >> 6) + 1) << 6
  const buf = new Uint8Array(totalBytes)
  buf.set(bytes)
  buf[bytes.length] = 0x80

  const view = new DataView(buf.buffer)
  view.setUint32(totalBytes - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(totalBytes - 4, bitLen >>> 0, false)

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19

  const w = new Uint32Array(64)
  for (let offset = 0; offset < totalBytes; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false)
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(7, w[i - 15]) ^ rotr(18, w[i - 15]) ^ (w[i - 15] >>> 3)
      const s1 = rotr(17, w[i - 2]) ^ rotr(19, w[i - 2]) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('')
}

/**
 * 与服务端 IngestService.openHash 完全对齐的 open 事件幂等哈希：
 * ["1.0.0", eventId, streamEpoch, deviceSeq, analysisEpoch, repoId, occurredAt, source]
 */
export function computeOpenEventPayloadHash({
  eventId,
  streamEpoch,
  deviceSeq,
  analysisEpoch,
  repoId,
  occurredAt,
  source = 'browse'
}) {
  const tuple = [
    EVENT_SCHEMA_VERSION,
    String(eventId),
    Number(streamEpoch),
    Number(deviceSeq),
    Number(analysisEpoch),
    String(repoId),
    Number(occurredAt),
    String(source)
  ]
  return sha256HexUtf8(JSON.stringify(tuple))
}

/**
 * discard 墓碑记录幂等哈希
 */
export function computeDiscardEventPayloadHash({
  eventId,
  streamEpoch,
  deviceSeq,
  analysisEpoch
}) {
  const tuple = [
    EVENT_SCHEMA_VERSION,
    String(eventId),
    Number(streamEpoch),
    Number(deviceSeq),
    Number(analysisEpoch),
    'discard'
  ]
  return sha256HexUtf8(JSON.stringify(tuple))
}

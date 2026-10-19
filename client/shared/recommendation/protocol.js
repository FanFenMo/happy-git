/**
 * shared/recommendation/protocol.js
 * Web Worker 通信消息结构与协议类型常量 (依据 project.md 第九节与第十四节)
 */

export const MODEL_VERSION = 'content-v1'

export const COMPUTE_PURPOSE = {
  PROFILE: 'profile',
  RANKING: 'ranking'
}

export function createComputeRequest({
  jobId,
  inputId,
  contextId,
  purpose,
  inputVersions,
  now = Date.now(),
  seed = 42,
  payload = {}
}) {
  return {
    jobId,
    inputId,
    contextId,
    purpose,
    modelVersion: MODEL_VERSION,
    inputVersions,
    now,
    seed,
    payload
  }
}

export function createComputeResult({
  jobId,
  inputId,
  contextId,
  purpose,
  inputVersions,
  profile = null,
  batch = null,
  error = null
}) {
  return {
    jobId,
    inputId,
    contextId,
    purpose,
    modelVersion: MODEL_VERSION,
    inputVersions,
    profile,
    batch,
    error
  }
}

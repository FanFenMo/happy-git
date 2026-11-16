/**
 * client/src/services/cloud.js
 * 云端应用会话、行为上传队列与兴趣分析偏好前端服务封装
 */

import { nativeBridge } from '../platform'
import { OPERATIONS } from '../../shared/contracts'

export async function beginCloudAuth(openBrowser = true) {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.CLOUD_AUTH_BEGIN, { openBrowser })
  if (!res.ok) {
    throw new Error(res.error?.message || '发起云端授权失败')
  }
  return res.data
}

export async function pollCloudAuth(challengeId) {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.CLOUD_AUTH_POLL, { challengeId })
  if (!res.ok) {
    throw new Error(res.error?.message || '查询云端授权状态失败')
  }
  return res.data
}

export async function cancelCloudAuth(challengeId) {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.CLOUD_AUTH_CANCEL, { challengeId })
  if (!res.ok) {
    throw new Error(res.error?.message || '取消云端授权失败')
  }
  return res.data
}

export async function restoreCloudSession() {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.CLOUD_SESSION_RESTORE)
  if (!res.ok) {
    throw new Error(res.error?.message || '恢复云端会话失败')
  }
  return res.data
}

export async function logoutCloudSession() {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.CLOUD_SESSION_LOGOUT)
  if (!res.ok) {
    throw new Error(res.error?.message || '退出云端会话失败')
  }
  return res.data
}

export async function readCloudSyncState() {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.CLOUD_SYNC_READ_STATE)
  if (!res.ok) {
    return null
  }
  return res.data
}

export async function flushCloudOutbox() {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.CLOUD_SYNC_FLUSH)
  if (!res.ok) {
    throw new Error(res.error?.message || '触发云端上传失败')
  }
  return res.data
}

export async function saveCloudPreferences(preferences) {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.CLOUD_PREFERENCES_SAVE, preferences)
  if (!res.ok) {
    throw new Error(res.error?.message || '保存云端分析偏好失败')
  }
  return res.data
}

export async function resetCloudAnalysis() {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.CLOUD_ANALYSIS_RESET)
  if (!res.ok) {
    throw new Error(res.error?.message || '重置云端分析数据失败')
  }
  return res.data
}

export async function syncCloudCollections(collections = ['stars', 'owned']) {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.CLOUD_COLLECTIONS_SYNC, { collections })
  if (!res.ok) {
    throw new Error(res.error?.message || '同步集合快照至云端失败')
  }
  return res.data
}

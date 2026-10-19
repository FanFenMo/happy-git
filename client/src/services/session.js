/**
 * client/src/services/session.js
 * 网页登录、恢复、取消、退出的前端编排 (依据 project.md 第四节与第五节)
 */

import { nativeBridge } from '../platform'
import { OPERATIONS } from '../../shared/contracts'

export async function initializeApplication() {
  const res = await nativeBridge.invoke(OPERATIONS.APP_INITIALIZE)
  if (!res.ok) {
    throw new Error(res.error?.message || '初始化应用失败')
  }
  return res.data
}

export async function beginLogin(intent = 'login') {
  const res = await nativeBridge.invoke(OPERATIONS.SESSION_BEGIN_LOGIN, { intent })
  if (!res.ok) {
    throw new Error(res.error?.message || '发起 GitHub 网页登录失败')
  }
  return res.data
}

export async function getLoginTask(loginTaskId) {
  const res = await nativeBridge.invoke(OPERATIONS.SESSION_GET_LOGIN_TASK, { loginTaskId })
  if (res.ok && res.data?.state) {
    return res.data
  }
  const fallback = await nativeBridge.invoke('auth.poll', { challengeId: loginTaskId })
  if (fallback.ok && fallback.data?.state) {
    return fallback.data
  }
  if (res.ok) return res.data
  throw new Error(res.error?.message || '获取登录任务状态失败')
}

export async function cancelLogin(loginTaskId) {
  const res = await nativeBridge.invoke(OPERATIONS.SESSION_CANCEL_LOGIN, { loginTaskId })
  if (!res.ok) {
    throw new Error(res.error?.message || '取消登录失败')
  }
  return res.data
}

export async function restoreSession() {
  const res = await nativeBridge.invoke(OPERATIONS.SESSION_RESTORE)
  if (!res.ok) {
    throw new Error(res.error?.message || '恢复会话失败')
  }
  return res.data
}

export async function logout() {
  const res = await nativeBridge.invoke(OPERATIONS.SESSION_LOGOUT)
  if (!res.ok) {
    throw new Error(res.error?.message || '退出登录失败')
  }
  return res.data
}

export async function forgetCurrentAccount() {
  const res = await nativeBridge.invoke(OPERATIONS.ACCOUNT_FORGET_LOCAL_DATA)
  if (!res.ok) {
    throw new Error(res.error?.message || '清除当前账号本地数据失败')
  }
  return res.data
}

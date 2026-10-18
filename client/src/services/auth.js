/**
 * 账号认证与会话服务
 */
import { nativeBridge } from '../platform'

export async function initializeApplication() {
  const res = await nativeBridge.invoke('app.initialize')
  if (!res.ok) {
    throw new Error(res.error?.message || '初始化应用失败')
  }
  return res.data
}

export async function startLogin() {
  const res = await nativeBridge.invoke('auth.begin')
  if (!res.ok) {
    throw new Error(res.error?.message || '发起设备码授权失败')
  }
  return res.data
}

export async function pollLogin(challengeId) {
  const res = await nativeBridge.invoke('auth.poll', { challengeId })
  if (!res.ok) {
    throw new Error(res.error?.message || '轮询授权状态失败')
  }
  return res.data
}

export async function cancelLogin(challengeId) {
  await nativeBridge.invoke('auth.cancel', { challengeId })
}

export async function restoreSession() {
  const res = await nativeBridge.invoke('auth.restore')
  if (!res.ok) {
    throw new Error(res.error?.message || '恢复会话失败')
  }
  return res.data
}

export async function logout() {
  const res = await nativeBridge.invoke('auth.logout')
  if (!res.ok) {
    throw new Error(res.error?.message || '退出登录失败')
  }
  return res.data
}

export async function forgetCurrentAccount() {
  const res = await nativeBridge.invoke('account.forgetLocalData')
  if (!res.ok) {
    throw new Error(res.error?.message || '清除账号本地数据失败')
  }
  return res.data
}

export async function saveModeSetting(mode) {
  await nativeBridge.invoke('settings.save', { mode })
}

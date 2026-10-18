/**
 * 本地浏览历史服务
 */
import { nativeBridge } from '../platform'

export async function recordHistory(repository, source = 'trending') {
  if (!repository || !repository.repoId) return null
  const res = await nativeBridge.invoke('history.record', {
    repository,
    source,
    viewedAt: Date.now()
  })
  if (!res.ok) {
    console.warn('[historyService] 记录浏览历史失败:', res.error?.message)
    return null
  }
  return res.data
}

export async function queryHistory({ cursor = null, limit = 30, keyword = '' } = {}) {
  const res = await nativeBridge.invoke('history.list', {
    cursor,
    limit,
    keyword
  })
  if (!res.ok) {
    throw new Error(res.error?.message || '查询历史记录失败')
  }
  return res.data
}

export async function deleteHistory(repoId) {
  const res = await nativeBridge.invoke('history.delete', { repoId })
  if (!res.ok) {
    throw new Error(res.error?.message || '删除单条历史失败')
  }
  return res.data
}

export async function clearHistory() {
  const res = await nativeBridge.invoke('history.clear')
  if (!res.ok) {
    throw new Error(res.error?.message || '清空历史失败')
  }
  return res.data
}

export async function countHistory() {
  const res = await nativeBridge.invoke('history.count')
  if (!res.ok) return 0
  return typeof res.data === 'number' ? res.data : 0
}

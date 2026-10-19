/**
 * client/src/services/discovery.js
 * 候选发现与热门开源列表服务 (依据 project.md 第四节与第九节)
 */

import { nativeBridge } from '../platform'
import { OPERATIONS } from '../../shared/contracts'

export async function refreshTrending() {
  const res = await nativeBridge.invoke(OPERATIONS.DISCOVERY_REFRESH, { mode: 'trending' })
  if (!res.ok) {
    throw new Error(res.error?.message || '获取热门项目失败')
  }
  return res.data
}

export async function readTrendingCache() {
  const res = await nativeBridge.invoke(OPERATIONS.DISCOVERY_READ, { key: 'feed:trending' })
  if (!res.ok) {
    return { items: [], fetchedAt: null }
  }
  return res.data
}

export async function refreshPersonalizedCandidates(queryPlan = []) {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.DISCOVERY_REFRESH, {
    mode: 'personalized',
    queryPlan
  })
  if (!res.ok) {
    throw new Error(res.error?.message || '刷新候选仓库失败')
  }
  return res.data
}

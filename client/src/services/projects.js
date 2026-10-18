/**
 * 项目访问与公开热门推荐服务
 */
import { nativeBridge } from '../platform'
import { normalizeTrendingRepository } from '../models/github'
import { getCutoffDate } from '../utils/time'
import { recordHistory } from './history'

export async function openRepository(repository, source = 'trending', canRecord = true) {
  if (!repository || !repository.htmlUrl) {
    return { opened: false, historySaved: false }
  }

  let historySaved = false
  if (canRecord) {
    const entry = await recordHistory(repository, source)
    historySaved = Boolean(entry)
  }

  const openRes = await nativeBridge.invoke('external.open', { url: repository.htmlUrl })
  return {
    opened: openRes.ok,
    historySaved
  }
}

export async function loadTrending({ force = false } = {}) {
  // 1. 若非强制刷新，优先检查缓存 (5分钟内有效)
  if (!force) {
    const cacheRes = await nativeBridge.invoke('feed.read', { key: 'trending_feed' })
    if (cacheRes.ok && cacheRes.data && cacheRes.data.items?.length > 0) {
      const now = Date.now()
      if (now - cacheRes.data.fetchedAt < 5 * 60 * 1000) {
        return {
          items: cacheRes.data.items.map((i) => normalizeTrendingRepository(i, 'cache')),
          source: 'cache',
          fetchedAt: cacheRes.data.fetchedAt
        }
      }
    }
  }

  // 2. 尝试从配置的后端服务获取
  const remoteRes = await nativeBridge.invoke('feed.fetchRemote')
  if (remoteRes.ok && Array.isArray(remoteRes.data) && remoteRes.data.length > 0) {
    const items = remoteRes.data.map((item) => normalizeTrendingRepository(item, 'server'))
    await nativeBridge.invoke('feed.save', { key: 'trending_feed', items, fetchedAt: Date.now() })
    return {
      items,
      source: 'server',
      fetchedAt: Date.now()
    }
  }

  // 3. 后端不可用时，直连 GitHub 搜索 API (近 3 个月创建，is:public，Star 降序)
  const cutoffDate = getCutoffDate(3)
  const query = `is:public created:>${cutoffDate} stars:>50`
  const ghRes = await nativeBridge.invoke('github.request', {
    resource: 'searchTrending',
    args: { query }
  })

  if (ghRes.ok && ghRes.data && ghRes.data.status === 200 && ghRes.data.body?.items) {
    const items = (ghRes.data.body.items || []).map((item) => normalizeTrendingRepository(item, 'github'))
    await nativeBridge.invoke('feed.save', { key: 'trending_feed', items, fetchedAt: Date.now() })
    return {
      items,
      source: 'github',
      fetchedAt: Date.now()
    }
  }

  // 4. 网络失败时回退到任何已有缓存
  const fallbackCache = await nativeBridge.invoke('feed.read', { key: 'trending_feed' })
  if (fallbackCache.ok && fallbackCache.data && fallbackCache.data.items?.length > 0) {
    return {
      items: fallbackCache.data.items.map((i) => normalizeTrendingRepository(i, 'cache')),
      source: 'cache',
      fetchedAt: fallbackCache.data.fetchedAt
    }
  }

  return {
    items: [],
    source: 'empty',
    fetchedAt: null
  }
}

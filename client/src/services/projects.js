/**
 * client/src/services/projects.js
 * 项目访问语义与热门开源数据发现 (依据 project.md 第四节、第十节与第十一节)
 */

import { nativeBridge } from '../platform'
import { OPERATIONS } from '../../shared/contracts'
import { useHistoryStore } from '../stores/history'
import { refreshTrending, readTrendingCache } from './discovery'

export async function openRepository(repository, source = 'trending', canRecord = true) {
  if (!repository || !repository.htmlUrl) {
    return { opened: false, historySaved: false }
  }

  const res = await nativeBridge.invoke(OPERATIONS.REPOSITORY_OPEN, {
    repository,
    source,
    target: 'external'
  })

  const opened = res.ok && res.data?.opened
  const historySaved = res.ok && res.data?.historySaved

  if (historySaved) {
    try {
      await useHistoryStore().refreshAfterVisit()
    } catch (_) {}
  }

  return {
    opened: Boolean(opened),
    historySaved: Boolean(historySaved)
  }
}

export async function loadTrending({ force = false } = {}) {
  if (!force) {
    const cached = await readTrendingCache()
    if (cached && cached.items?.length > 0) {
      return {
        items: cached.items,
        source: 'cache',
        fetchedAt: cached.fetchedAt
      }
    }
  }

  try {
    const fresh = await refreshTrending()
    return {
      items: fresh.items || [],
      source: 'web',
      fetchedAt: Date.now()
    }
  } catch (err) {
    const fallback = await readTrendingCache()
    if (fallback && fallback.items?.length > 0) {
      return {
        items: fallback.items,
        source: 'cache',
        fetchedAt: fallback.fetchedAt
      }
    }
    return {
      items: [],
      source: 'empty',
      fetchedAt: null
    }
  }
}

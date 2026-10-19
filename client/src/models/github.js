/**
 * client/src/models/github.js
 * 兼容网页 DTO，清除虚构默认值 (依据 project.md 第四节与第十一节)
 */

import {
  parseCount,
  parseTimestamp,
  normalizeProfile,
  normalizeRepository
} from '../../shared/github-page/normalize.js'

export {
  parseCount,
  parseTimestamp,
  normalizeProfile,
  normalizeRepository
}

// 兼容旧组件引用的别名
export function normalizeStarredRepository(raw, fetchedAt = Date.now()) {
  return normalizeRepository(raw, 'stars', fetchedAt)
}

export function normalizeTrendingRepository(raw, source = 'trending') {
  return normalizeRepository(raw, source, Date.now())
}

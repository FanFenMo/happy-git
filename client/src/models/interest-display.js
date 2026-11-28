import { describeProjectKeywords, extractProjectKeywords } from '../../shared/recommendation/keywords.js'

export const projectKeywordMethods = {
  feature_space: '模型特征',
  local_tfidf: '本机文本分析',
  on_demand_fallback: '公开项目信息估算'
}

export function projectKeywords(repository) {
  const payload = repository.keywordWeights
  const items = Array.isArray(payload?.items) ? payload.items.filter(item =>
    Array.isArray(item) && typeof item[0] === 'string' && item[0].trim() &&
    Number.isFinite(item[1]) && item[1] > 0
  ).sort((a, b) => b[1] - a[1]).slice(0, 14) : []

  return items.length
    ? describeProjectKeywords({ ...payload, items })
    : extractProjectKeywords(repository)
}

export function formatShare(value) {
  return value > 0 && value < .1 ? '<0.1%' : `${Number(value.toFixed(1))}%`
}

// 最小直径留出关键词的阅读空间，高权重仍有严格更大的气泡。
export function keywordBubbleScale(weight) {
  return .56 + .44 * Math.sqrt(Math.max(0, Math.min(1, weight)))
}

/**
 * shared/recommendation/rank.js
 * 候选项目评分、MMR 多样性重排与解释生成 (依据 project.md 第九节)
 */

export function weightedAvailable(components) {
  let weightedSum = 0
  let availableWeight = 0

  for (const { value, weight } of components) {
    if (value !== null && value !== undefined && Number.isFinite(value)) {
      weightedSum += value * weight
      availableWeight += weight
    }
  }

  return availableWeight > 0 ? (weightedSum / availableWeight) : 0
}

export function scoreCandidate(profile, candidate, now = Date.now(), openedRecent = false) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000

  // 1. 语言相似度
  let languageSimilarity = null
  if (candidate.primaryLanguage && profile?.languages) {
    languageSimilarity = profile.languages[candidate.primaryLanguage] || 0
  }

  // 2. Topic 相似度 (候选 topic 在用户偏好分布中的权重均值)
  let topicSimilarity = null
  if (Array.isArray(candidate.topics) && candidate.topics.length > 0 && profile?.topics) {
    let sum = 0
    let matches = 0
    for (const t of candidate.topics) {
      const clean = t.toLowerCase()
      if (profile.topics[clean]) {
        sum += profile.topics[clean]
        matches++
      }
    }
    topicSimilarity = matches > 0 ? (sum / matches) : 0
  }

  // 3. 文本向量余弦相似度 (L2 向量点积)
  let textCosine = null
  if (candidate.vector && profile?.vector) {
    let dot = 0
    for (const [k, v] of Object.entries(candidate.vector)) {
      if (profile.vector[k]) {
        dot += v * profile.vector[k]
      }
    }
    textCosine = Math.max(0, Math.min(dot, 1))
  }

  // 综合兴趣得分 (30% 语言, 35% Topic, 35% 文本)
  const interestScore = weightedAvailable([
    { value: languageSimilarity, weight: 0.30 },
    { value: topicSimilarity, weight: 0.35 },
    { value: textCosine, weight: 0.35 }
  ])

  // 4. 新鲜度 Freshness
  let freshness = null
  if (candidate.updatedAt) {
    const daysSinceUpdate = Math.max(0, (now - candidate.updatedAt) / MS_PER_DAY)
    freshness = Math.pow(2, -daysSinceUpdate / 180)
  }

  // 5. 受欢迎程度 Popularity
  let popularity = null
  if (candidate.starCount !== null && candidate.starCount !== undefined) {
    popularity = Math.min(Math.log(1 + candidate.starCount) / Math.log(10001), 1)
  }

  // 6. 信息充分度 Info
  let infoCount = 0
  if (candidate.readmeText) infoCount++
  if (candidate.description) infoCount++
  if (candidate.topics && candidate.topics.length > 0) infoCount++
  if (candidate.primaryLanguage) infoCount++
  const info = infoCount / 4.0

  // 7. 趋势增长分量 Trend (若有两次明确观测)
  let trend = null
  if (candidate.previousStarCount && candidate.previousObservedAt) {
    const elapsedDays = (now - candidate.previousObservedAt) / MS_PER_DAY
    if (elapsedDays >= 1.0) {
      const dailyIncrease = Math.max(0, candidate.starCount - candidate.previousStarCount) / elapsedDays
      trend = Math.min(Math.log(1 + dailyIncrease) / Math.log(101), 1)
    }
  }

  // 基础总分 BaseScore
  let baseScore = weightedAvailable([
    { value: interestScore, weight: 0.65 },
    { value: freshness, weight: 0.15 },
    { value: popularity, weight: 0.08 },
    { value: info, weight: 0.07 },
    { value: trend, weight: 0.05 }
  ])

  // 最近 24 小时已打开的候选，打 5 折降权
  if (openedRecent) {
    baseScore *= 0.5
  }

  return {
    baseScore: parseFloat(baseScore.toFixed(4)),
    parts: {
      interest: interestScore,
      freshness,
      popularity,
      info,
      trend,
      matchedLang: languageSimilarity > 0 ? candidate.primaryLanguage : null,
      matchedTopics: (candidate.topics || []).filter(t => profile?.topics?.[t.toLowerCase()])
    }
  }
}

export function buildRecommendationReasons(profile, candidate, scoreParts) {
  const reasons = []
  if (scoreParts?.matchedTopics?.length > 0) {
    reasons.push(`匹配你关注的技术标签 #${scoreParts.matchedTopics[0]}`)
  } else if (scoreParts?.matchedLang) {
    reasons.push(`与你常用的 ${scoreParts.matchedLang} 生态相关`)
  } else if (scoreParts?.popularity > 0.7) {
    reasons.push('近期高关注度开源热门项目')
  } else {
    reasons.push('换个方向看看 (探索发现)')
  }
  return reasons.slice(0, 2)
}

function calculateItemSimilarity(a, b) {
  let sim = 0
  if (a.primaryLanguage && a.primaryLanguage === b.primaryLanguage) {
    sim += 0.5
  }
  const setA = new Set((a.topics || []).map(t => t.toLowerCase()))
  const setB = new Set((b.topics || []).map(t => t.toLowerCase()))
  if (setA.size > 0 && setB.size > 0) {
    let intersect = 0
    for (const t of setA) {
      if (setB.has(t)) intersect++
    }
    const union = new Set([...setA, ...setB]).size
    sim += 0.5 * (intersect / union)
  }
  return sim
}

export function rerankCandidates(scoredCandidates, limit = 100, seed = 42) {
  if (scoredCandidates.length <= limit) {
    return scoredCandidates
  }

  const selected = []
  const remaining = [...scoredCandidates]

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = -1
    let bestScore = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]

      // 计算与已选中项目的最大相似度
      let maxSim = 0
      for (const sel of selected) {
        const s = calculateItemSimilarity(cand.candidate, sel.candidate)
        if (s > maxSim) maxSim = s
      }

      // MMR 评分: 0.8 * baseScore - 0.2 * maxSim
      const mmrScore = 0.8 * cand.baseScore - 0.2 * maxSim

      // 规则约束: 任意连续 10 条中同一 owner 最多 2 个
      const recent10 = selected.slice(-10)
      const sameOwnerCount = recent10.filter(s => s.candidate.owner === cand.candidate.owner).length
      if (sameOwnerCount >= 2 && remaining.length > 5) {
        continue
      }

      if (mmrScore > bestScore) {
        bestScore = mmrScore
        bestIdx = i
      }
    }

    if (bestIdx >= 0) {
      selected.push(remaining.splice(bestIdx, 1)[0])
    } else {
      // 无法满足约束时放宽选择最高分
      selected.push(remaining.shift())
    }
  }

  return selected
}

export function createRecommendationBatch({
  batchId,
  accountId,
  profile,
  candidates = [],
  now = Date.now(),
  inputVersions = {},
  seed = 42,
  historyMap = new Map(),
  hiddenSet = new Set(),
  ownedSet = new Set()
}) {
  const scored = []

  for (const cand of candidates) {
    // 排除私有、已隐藏及本人仓库
    if (cand.visibility === 'private' || hiddenSet.has(cand.repoId) || ownedSet.has(cand.canonicalKey)) {
      continue
    }

    const openedRecent = historyMap.has(cand.canonicalKey)
    const { baseScore, parts } = scoreCandidate(profile, cand, now, openedRecent)
    const reasons = buildRecommendationReasons(profile, cand, parts)

    scored.push({
      candidate: cand,
      baseScore,
      reasons
    })
  }

  // MMR 重排
  const ranked = rerankCandidates(scored, 100, seed)

  const items = ranked.map((item, index) => ({
    batchId,
    position: index + 1,
    repoId: item.candidate.repoId || item.candidate.canonicalKey,
    score: item.baseScore,
    reasons: item.reasons,
    repository: item.candidate
  }))

  return {
    batchId,
    accountId,
    modelVersion: 'content-v1',
    inputVersions,
    createdAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,
    items
  }
}

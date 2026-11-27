/**
 * shared/recommendation/rank.js
 * 候选项目评分、云端长期画像与本机未处理增量接续、MMR 多样性重排与解释生成
 * (依据 project.md 第九节、接口与模型契约及第二轮本地排序规范)
 */

import {
  SERVER_VECTOR_DIMENSION,
  addSparseVector,
  buildVocabulary,
  extractRepositoryFeatures,
  normalizeDenseToSparse,
  projectRepositoryToFeatureSpace,
  sparseDotProduct
} from './features.js'
import { buildInterestProfile } from './profile.js'
import { buildReverseFeatureSpace, extractProjectKeywordWeights } from './keywords.js'

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

function isSparseVector(vec) {
  return Boolean(vec && typeof vec === 'object' && Array.isArray(vec.indices) && Array.isArray(vec.values))
}

function getCandidateVector(profile, candidate, featureSpace = null) {
  if (!candidate) return null
  if (candidate.vector && typeof candidate.vector === 'object' && !Array.isArray(candidate.vector.indices) && Object.keys(candidate.vector).length > 0) {
    if (!profile?.vocabulary || !candidate.vocabularyVersion || candidate.vocabularyVersion === profile.vocabulary.version) {
      return candidate.vector
    }
  }
  if (profile?.vocabulary) {
    const extracted = extractRepositoryFeatures(candidate, profile.vocabulary, featureSpace)
    return extracted.vector
  }
  return (candidate.vector && !Array.isArray(candidate.vector.indices)) ? candidate.vector : null
}

function getCandidateSparseVector(candidate, featureSpace = null) {
  if (!candidate) return null
  if (isSparseVector(candidate.sparseVector)) return candidate.sparseVector
  if (isSparseVector(candidate.vector)) return candidate.vector
  if (featureSpace) {
    const projected = projectRepositoryToFeatureSpace(candidate, featureSpace)
    return projected ? projected.sparseVector : null
  }
  return null
}

/**
 * 从尚未被 processedThrough 覆盖的本机近期有效事件构建增量上下文。
 * 严格遵循：acceptedThrough 只代表服务端已收到；只有 processedThrough 覆盖后才停止作为本机增量。
 */
export function buildRecentIncrementContext({
  unprocessedEvents = [],
  processedThrough = 0,
  historyMap = new Map(),
  featureSpace = null,
  vocabulary = null,
  hiddenSet = new Set(),
  now = Date.now()
} = {}) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000
  const cutoffSeq = Number(processedThrough || 0)
  const validEvents = []

  for (const ev of (Array.isArray(unprocessedEvents) ? unprocessedEvents : [])) {
    if (!ev || ev.recordKind === 'discard') continue
    if (ev.deviceSeq !== undefined && ev.deviceSeq !== null && Number(ev.deviceSeq) <= cutoffSeq) {
      continue
    }
    const repoId = ev.repoId ? String(ev.repoId) : null
    if (repoId && hiddenSet.has(repoId)) continue
    validEvents.push(ev)
  }

  if (validEvents.length === 0) {
    return null
  }

  // 按仓库聚合未处理打开次数与最近时间
  const byRepo = new Map()
  for (const ev of validEvents) {
    const repoKey = String(ev.repoId || ev.fullName || '').toLowerCase()
    if (!repoKey) continue
    const at = Number(ev.effectiveAt || ev.occurredAt || now)
    const existing = byRepo.get(repoKey)
    const repoObj = ev.repository || historyMap.get(repoKey)?.repository || historyMap.get(String(ev.repoId))?.repository || null
    if (existing) {
      existing.opens += 1
      existing.lastAt = Math.max(existing.lastAt, at)
      if (!existing.repository && repoObj) existing.repository = repoObj
    } else {
      byRepo.set(repoKey, {
        repoId: ev.repoId ? String(ev.repoId) : null,
        fullName: ev.fullName || repoObj?.fullName || null,
        opens: 1,
        lastAt: at,
        repository: repoObj
      })
    }
  }

  const langWeights = new Map()
  const topicWeights = new Map()
  const denseTermWeights = {}
  const sparseSum = featureSpace ? new Float64Array(SERVER_VECTOR_DIMENSION) : null
  const recentRepos = []
  let totalWeight = 0

  for (const item of byRepo.values()) {
    const days = Math.max(0, (now - item.lastAt) / MS_PER_DAY)
    const weight = Math.min(1 + Math.log(item.opens), 3) * Math.pow(2, -days / 14)
    totalWeight += weight

    const repo = item.repository
    if (repo) {
      recentRepos.push({
        repoId: item.repoId || repo.repoId,
        fullName: item.fullName || repo.fullName,
        primaryLanguage: repo.primaryLanguage,
        topics: repo.topics || [],
        weight
      })
      if (repo.primaryLanguage && repo.primaryLanguage !== '未标注') {
        langWeights.set(repo.primaryLanguage, (langWeights.get(repo.primaryLanguage) || 0) + weight)
      }
      for (const t of (repo.topics || [])) {
        const clean = String(t).trim().toLowerCase()
        if (clean) topicWeights.set(clean, (topicWeights.get(clean) || 0) + weight)
      }
      if (sparseSum && featureSpace) {
        const sp = getCandidateSparseVector(repo, featureSpace)
        if (sp) addSparseVector(sparseSum, sp, weight)
      }
      if (vocabulary) {
        const vec = getCandidateVector({ vocabulary }, repo)
        if (vec) {
          for (const [term, val] of Object.entries(vec)) {
            if (Number.isFinite(val) && val > 0) {
              denseTermWeights[term] = (denseTermWeights[term] || 0) + val * weight
            }
          }
        }
      }
    }
  }

  const languages = {}
  let langTotal = 0
  for (const v of langWeights.values()) langTotal += v
  if (langTotal > 0) {
    for (const [k, v] of langWeights.entries()) languages[k] = v / langTotal
  }

  const topics = {}
  let topicTotal = 0
  for (const v of topicWeights.values()) topicTotal += v
  if (topicTotal > 0) {
    for (const [k, v] of topicWeights.entries()) topics[k] = v / topicTotal
  }

  let denseVector = {}
  let denseNormSq = 0
  for (const v of Object.values(denseTermWeights)) denseNormSq += v * v
  if (denseNormSq > 0) {
    const norm = Math.sqrt(denseNormSq)
    for (const [k, v] of Object.entries(denseTermWeights)) denseVector[k] = v / norm
  }

  const sparseVector = sparseSum ? normalizeDenseToSparse(sparseSum, 256) : null

  return {
    eventCount: validEvents.length,
    repoCount: byRepo.size,
    processedThrough: cutoffSeq,
    totalWeight,
    languages,
    topics,
    denseVector,
    sparseVector,
    recentRepos
  }
}

function computeDirectionMatch(profile, candidate) {
  const directions = Array.isArray(profile?.directions)
    ? profile.directions
    : (Array.isArray(profile?.profile?.directions) ? profile.profile.directions : [])
  if (directions.length === 0 || !candidate) {
    return { score: null, matchedDirection: null }
  }

  const candTopics = new Set((candidate.topics || []).map(t => String(t).toLowerCase()))
  const candLang = candidate.primaryLanguage ? String(candidate.primaryLanguage).toLowerCase() : null

  let bestScore = 0
  let bestDirection = null
  for (const dir of directions) {
    if (!dir || typeof dir !== 'object') continue
    const dirWeight = Number.isFinite(Number(dir.weight)) ? Math.max(0, Math.min(1, Number(dir.weight))) : 0.5
    const dirTopics = (Array.isArray(dir.topics) ? dir.topics : []).map(t => String(t).toLowerCase())
    const dirLangs = (Array.isArray(dir.languages) ? dir.languages : []).map(l => String(l).toLowerCase())

    let topicHits = 0
    for (const t of dirTopics) {
      if (candTopics.has(t)) topicHits++
    }
    const topicRatio = dirTopics.length > 0 ? Math.min(1, topicHits / Math.min(2, dirTopics.length)) : 0
    const langMatch = (candLang && dirLangs.includes(candLang)) ? 1 : 0
    const matchStrength = dirTopics.length > 0 && dirLangs.length > 0
      ? (0.7 * topicRatio + 0.3 * langMatch)
      : (topicRatio || langMatch)

    const weighted = matchStrength * (0.5 + 0.5 * dirWeight)
    if (weighted > bestScore && matchStrength > 0) {
      bestScore = weighted
      bestDirection = dir
    }
  }

  return {
    score: bestDirection ? Math.min(1, bestScore) : 0,
    matchedDirection: bestDirection
  }
}

export function scoreCandidate(profile, candidate, now = Date.now(), openedRecent = false, options = {}) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000
  const featureSpace = options?.featureSpace || profile?.featureSpace || null
  const recentIncrement = options?.recentIncrement || null
  const effectiveProfile = profile?.profile && typeof profile.profile === 'object' ? profile.profile : profile

  // 1. 语言相似度
  let languageSimilarity = null
  const hasProfileLangs = effectiveProfile?.languages && Object.keys(effectiveProfile.languages).length > 0
  if (candidate.primaryLanguage && hasProfileLangs) {
    languageSimilarity = effectiveProfile.languages[candidate.primaryLanguage] || 0
  }

  // 2. Topic 相似度 (候选 topic 在用户偏好分布中的权重均值)
  let topicSimilarity = null
  const hasProfileTopics = effectiveProfile?.topics && Object.keys(effectiveProfile.topics).length > 0
  if (Array.isArray(candidate.topics) && candidate.topics.length > 0 && hasProfileTopics) {
    let sum = 0
    let matches = 0
    for (const t of candidate.topics) {
      const clean = String(t).toLowerCase()
      if (effectiveProfile.topics[clean]) {
        sum += effectiveProfile.topics[clean]
        matches++
      }
    }
    topicSimilarity = matches > 0 ? (sum / matches) : 0
  }

  // 3. 向量余弦相似度：优先使用服务端 8192 维同构稀疏向量，兼容本地词表向量
  let textCosine = null
  const profileSparseVec = isSparseVector(effectiveProfile?.sparseVector)
    ? effectiveProfile.sparseVector
    : (isSparseVector(effectiveProfile?.vector) ? effectiveProfile.vector : (isSparseVector(profile?.vector) ? profile.vector : null))
  const candidateSparseVec = getCandidateSparseVector(candidate, featureSpace)

  if (profileSparseVec && candidateSparseVec && profileSparseVec.indices.length > 0 && candidateSparseVec.indices.length > 0) {
    textCosine = sparseDotProduct(profileSparseVec, candidateSparseVec)
  } else {
    const candidateVector = getCandidateVector(effectiveProfile, candidate, featureSpace)
    const profileVector = (effectiveProfile?.vector && !isSparseVector(effectiveProfile.vector)) ? effectiveProfile.vector : null
    const hasProfileVec = profileVector && typeof profileVector === 'object' && Object.keys(profileVector).length > 0
    const hasCandidateVec = candidateVector && typeof candidateVector === 'object' && Object.keys(candidateVector).length > 0
    if (hasProfileVec && hasCandidateVec) {
      let dot = 0
      for (const [k, v] of Object.entries(candidateVector)) {
        if (profileVector[k]) {
          dot += v * profileVector[k]
        }
      }
      textCosine = Math.max(0, Math.min(dot, 1))
    }
  }

  // 4. 学习型兴趣方向匹配度 (若有 directions)
  const { score: directionSimilarity, matchedDirection } = computeDirectionMatch(profile, candidate)

  // 长期画像综合得分
  const hasLongTermSignal =
    (languageSimilarity !== null) ||
    (topicSimilarity !== null) ||
    (textCosine !== null) ||
    (directionSimilarity !== null)
  const longTermInterest = hasLongTermSignal
    ? weightedAvailable([
        { value: languageSimilarity, weight: 0.25 },
        { value: topicSimilarity, weight: 0.30 },
        { value: textCosine, weight: 0.30 },
        { value: directionSimilarity, weight: 0.15 }
      ])
    : null

  // 5. 本机未处理近期行为增量 (仅针对 deviceSeq > processedThrough 的事件)
  let recentIncrementScore = null
  let matchedRecentRepo = null
  if (recentIncrement && recentIncrement.eventCount > 0) {
    const recLangSim = (candidate.primaryLanguage && Object.keys(recentIncrement.languages || {}).length > 0)
      ? (recentIncrement.languages[candidate.primaryLanguage] || 0)
      : null
    let recTopicSim = null
    if (Array.isArray(candidate.topics) && candidate.topics.length > 0 && Object.keys(recentIncrement.topics || {}).length > 0) {
      let s = 0
      let m = 0
      for (const t of candidate.topics) {
        const clean = String(t).toLowerCase()
        if (recentIncrement.topics[clean]) {
          s += recentIncrement.topics[clean]
          m++
        }
      }
      recTopicSim = m > 0 ? (s / m) : 0
    }
    let recVecSim = null
    if (recentIncrement.sparseVector && candidateSparseVec && recentIncrement.sparseVector.indices.length > 0 && candidateSparseVec.indices.length > 0) {
      recVecSim = sparseDotProduct(recentIncrement.sparseVector, candidateSparseVec)
    } else if (recentIncrement.denseVector && Object.keys(recentIncrement.denseVector).length > 0) {
      const candVec = getCandidateVector(effectiveProfile, candidate, featureSpace)
      if (candVec && Object.keys(candVec).length > 0) {
        let dot = 0
        for (const [k, v] of Object.entries(candVec)) {
          if (recentIncrement.denseVector[k]) dot += v * recentIncrement.denseVector[k]
        }
        recVecSim = Math.max(0, Math.min(dot, 1))
      }
    }
    if (recLangSim !== null || recTopicSim !== null || recVecSim !== null) {
      recentIncrementScore = weightedAvailable([
        { value: recLangSim, weight: 0.30 },
        { value: recTopicSim, weight: 0.40 },
        { value: recVecSim, weight: 0.30 }
      ])
    }
    if (recentIncrementScore && recentIncrementScore > 0.1 && Array.isArray(recentIncrement.recentRepos)) {
      const candTopicSet = new Set((candidate.topics || []).map(t => String(t).toLowerCase()))
      matchedRecentRepo = recentIncrement.recentRepos.find(r =>
        (r.topics || []).some(t => candTopicSet.has(String(t).toLowerCase())) ||
        (r.primaryLanguage && r.primaryLanguage === candidate.primaryLanguage)
      ) || recentIncrement.recentRepos[0] || null
    }
  }

  // 合并长期画像与本机未处理增量
  const hasAnyInterestSignal = (longTermInterest !== null) || (recentIncrementScore !== null)
  const interestScore = hasAnyInterestSignal
    ? (recentIncrementScore !== null && longTermInterest !== null
        ? (0.75 * longTermInterest + 0.25 * recentIncrementScore)
        : (longTermInterest ?? recentIncrementScore))
    : null

  // 6. 维护活跃度 Freshness
  let freshness = null
  const activeTimestamp = candidate.pushedAt || candidate.updatedAt
  if (activeTimestamp) {
    const daysSinceUpdate = Math.max(0, (now - activeTimestamp) / MS_PER_DAY)
    freshness = Math.pow(2, -daysSinceUpdate / 180)
  }

  // 7. 社区关注度信号 Attention Signal (Star 命名为关注度信号，绝不冒充质量评分)
  let popularity = null
  if (candidate.starCount !== null && candidate.starCount !== undefined) {
    popularity = Math.min(Math.log(1 + Math.max(0, candidate.starCount)) / Math.log(10001), 1)
  }

  // 8. 项目证据与信息完备度 Info (含用途、许可证、安装/示例线索、技术标签)
  let infoCount = 0
  if (candidate.readmeText || candidate.installCue) infoCount++
  if (candidate.description || candidate.purposeCue) infoCount++
  if (candidate.topics && candidate.topics.length > 0) infoCount++
  if (candidate.primaryLanguage) infoCount++
  if (candidate.licenseSpdx) infoCount += 0.5
  const info = Math.min(1.0, infoCount / 4.0)

  // 9. 趋势增长分量 Trend (若有两次明确观测)
  let trend = null
  if (candidate.previousStarCount !== undefined && candidate.previousStarCount !== null && candidate.previousObservedAt) {
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
      longTermInterest,
      recentIncrement: recentIncrementScore,
      directionSimilarity,
      matchedDirection: matchedDirection ? (matchedDirection.label || matchedDirection.directionId || null) : null,
      matchedRecentRepo: matchedRecentRepo ? (matchedRecentRepo.fullName || matchedRecentRepo.repoId || null) : null,
      textCosine,
      freshness,
      popularity,
      attentionSignal: popularity,
      info,
      trend,
      matchedLang: languageSimilarity > 0 ? candidate.primaryLanguage : null,
      matchedTopics: (candidate.topics || []).filter(t => effectiveProfile?.topics?.[String(t).toLowerCase()])
    }
  }
}

export function buildRecommendationReasons(profile, candidate, scoreParts) {
  const reasons = []
  if (scoreParts?.matchedDirection) {
    reasons.push(`契合兴趣方向「${scoreParts.matchedDirection}」`)
  }
  if (scoreParts?.matchedTopics?.length > 0) {
    reasons.push(`匹配你关注的技术标签 #${scoreParts.matchedTopics[0]}`)
  }
  if (scoreParts?.recentIncrement > 0.25 && scoreParts?.matchedRecentRepo) {
    reasons.push(`接续近期浏览 ${scoreParts.matchedRecentRepo} 的技术线索`)
  }
  if (scoreParts?.matchedLang && reasons.length < 2) {
    reasons.push(`与你常用的 ${scoreParts.matchedLang} 生态相关`)
  }
  if (reasons.length === 0 && scoreParts?.textCosine > 0.25) {
    reasons.push('项目技术说明与你的兴趣方向相近')
  }
  if (reasons.length === 0 && scoreParts?.attentionSignal > 0.7) {
    reasons.push('近期高关注度开源项目')
  }
  if (reasons.length === 0) {
    reasons.push('换个方向看看 (探索发现)')
  }
  return reasons.slice(0, 2)
}

function resolveOwnerKey(repo) {
  if (!repo) return ''
  if (repo.owner) return String(repo.owner).toLowerCase()
  if (repo.fullName && String(repo.fullName).includes('/')) {
    return String(repo.fullName).split('/')[0].toLowerCase()
  }
  if (repo.canonicalKey && String(repo.canonicalKey).includes('/')) {
    return String(repo.canonicalKey).split('/')[0].toLowerCase()
  }
  return ''
}

function resolveLangKey(repo) {
  if (!repo || !repo.primaryLanguage || repo.primaryLanguage === '未标注') return ''
  return String(repo.primaryLanguage).trim().toLowerCase()
}

function calculateItemSimilarity(a, b) {
  if (!a || !b) return 0
  let sim = 0
  const langA = resolveLangKey(a)
  const langB = resolveLangKey(b)
  if (langA && langA === langB) {
    sim += 0.35
  }

  const setA = new Set((a.topics || []).map(t => String(t).toLowerCase()))
  const setB = new Set((b.topics || []).map(t => String(t).toLowerCase()))
  if (setA.size > 0 && setB.size > 0) {
    let intersect = 0
    for (const t of setA) {
      if (setB.has(t)) intersect++
    }
    const union = new Set([...setA, ...setB]).size
    if (union > 0) {
      sim += 0.35 * (intersect / union)
    }
  }

  if (isSparseVector(a.sparseVector) && isSparseVector(b.sparseVector)) {
    const dot = sparseDotProduct(a.sparseVector, b.sparseVector) ?? 0
    sim += 0.30 * dot
  } else if (a.vector && b.vector && !isSparseVector(a.vector) && !isSparseVector(b.vector)) {
    let dot = 0
    for (const [k, v] of Object.entries(a.vector)) {
      if (b.vector[k]) {
        dot += v * b.vector[k]
      }
    }
    sim += 0.30 * Math.max(0, Math.min(dot, 1))
  } else if (sim > 0) {
    sim = Math.min(1, sim / 0.70)
  }

  return Math.max(0, Math.min(sim, 1))
}

export function rerankCandidates(scoredCandidates, limit = 100, seed = 42) {
  if (!Array.isArray(scoredCandidates) || scoredCandidates.length === 0 || limit <= 0) {
    return []
  }

  const targetCount = Math.min(limit, scoredCandidates.length)
  const selected = []
  const remaining = scoredCandidates.map((item, idx) => ({
    ...item,
    _initIdx: idx
  }))

  while (selected.length < targetCount && remaining.length > 0) {
    // 连续 10 条滑动窗口：最近已选的 9 条 + 当前待选的 1 条
    const window9 = selected.slice(-9)
    const ownerCounts = new Map()
    const langCounts = new Map()

    for (const sel of window9) {
      const owner = resolveOwnerKey(sel.candidate)
      if (owner) ownerCounts.set(owner, (ownerCounts.get(owner) || 0) + 1)
      const lang = resolveLangKey(sel.candidate)
      if (lang) langCounts.set(lang, (langCounts.get(lang) || 0) + 1)
    }

    // 检查剩余池中是否存在不同语言的候选
    const distinctRemainingLangs = new Set(remaining.map(r => resolveLangKey(r.candidate)).filter(Boolean))

    function pickBest(filterMode) {
      let bestIdx = -1
      let bestMmr = -Infinity
      let bestBase = -Infinity

      for (let i = 0; i < remaining.length; i++) {
        const item = remaining[i]
        const cand = item.candidate || {}
        const owner = resolveOwnerKey(cand)
        const lang = resolveLangKey(cand)

        if (filterMode === 'strict' || filterMode === 'owner_only') {
          if (owner && (ownerCounts.get(owner) || 0) >= 2) {
            continue
          }
        }

        if (filterMode === 'strict') {
          if (lang && distinctRemainingLangs.size > 1 && (langCounts.get(lang) || 0) >= 6) {
            continue
          }
        }

        let maxSim = 0
        for (const sel of selected) {
          const s = calculateItemSimilarity(cand, sel.candidate)
          if (s > maxSim) maxSim = s
        }

        const mmrScore = 0.8 * (item.baseScore ?? 0) - 0.2 * maxSim
        if (
          mmrScore > bestMmr + 1e-9 ||
          (Math.abs(mmrScore - bestMmr) <= 1e-9 && (item.baseScore ?? 0) > bestBase + 1e-9)
        ) {
          bestMmr = mmrScore
          bestBase = item.baseScore ?? 0
          bestIdx = i
        }
      }

      return bestIdx
    }

    let chosenIdx = pickBest('strict')
    if (chosenIdx < 0) {
      chosenIdx = pickBest('owner_only')
    }
    if (chosenIdx < 0) {
      chosenIdx = pickBest('relaxed')
    }
    if (chosenIdx < 0) {
      chosenIdx = 0
    }

    const [picked] = remaining.splice(chosenIdx, 1)
    const { _initIdx, ...cleanPicked } = picked
    selected.push(cleanPicked)
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
  ownedSet = new Set(),
  featureSpace = null,
  unprocessedEvents = [],
  processedThrough = 0
}) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000
  const effectiveFeatureSpace = featureSpace || profile?.featureSpace || null
  const innerProfile = profile?.profile && typeof profile.profile === 'object' ? profile.profile : profile
  const evidenceRepos = Array.isArray(innerProfile?.evidenceRepos) ? innerProfile.evidenceRepos : []

  // 若服务端提供了已发布 featureSpace，则严格使用固定投影规则，不自行重新拟合不兼容词表
  let sharedVocabulary = null
  let activeProfile = innerProfile || profile

  if (!effectiveFeatureSpace) {
    sharedVocabulary = buildVocabulary([...evidenceRepos, ...(candidates || [])])
    if (activeProfile) {
      const needsReproject =
        !activeProfile.vector ||
        isSparseVector(activeProfile.vector) ||
        Object.keys(activeProfile.vector).length === 0 ||
        !activeProfile.vocabulary ||
        activeProfile.vocabulary.terms?.length !== sharedVocabulary.terms?.length
      if (needsReproject && evidenceRepos.length > 0 && evidenceRepos.some(r => typeof r === 'object' && r.sources)) {
        const rebuilt = buildInterestProfile({
          accountId: activeProfile.accountId || accountId,
          starred: evidenceRepos.filter(r => r.sources?.includes('star')),
          owned: evidenceRepos.filter(r => r.sources?.includes('owned')),
          history: evidenceRepos
            .filter(r => r.sources?.includes('history'))
            .map(r => ({ repository: r, visitCount: 1, lastViewedAt: now })),
          manualTags: activeProfile.manualTags || [],
          hiddenRepoIds: Array.from(hiddenSet),
          historyEnabled: true,
          now,
          inputVersions: activeProfile.inputVersions || inputVersions,
          vocabulary: sharedVocabulary
        })
        activeProfile = {
          ...activeProfile,
          vector: rebuilt.vector,
          vocabulary: sharedVocabulary,
          vocabularyVersion: sharedVocabulary.version
        }
      } else if (!activeProfile.vocabulary) {
        activeProfile = {
          ...activeProfile,
          vocabulary: sharedVocabulary,
          vocabularyVersion: sharedVocabulary.version
        }
      }
    }
  }

  const effectiveProcessedThrough = Number(
    processedThrough ??
    profile?.processedThrough ??
    innerProfile?.processedThrough ??
    inputVersions?.processedThrough ??
    0
  )

  const recentIncrement = buildRecentIncrementContext({
    unprocessedEvents,
    processedThrough: effectiveProcessedThrough,
    historyMap,
    featureSpace: effectiveFeatureSpace,
    vocabulary: sharedVocabulary,
    hiddenSet,
    now
  })

  const recentUnprocessedKeys = new Set()
  for (const ev of (unprocessedEvents || [])) {
    if (!ev || ev.recordKind === 'discard') continue
    const seq = Number(ev.deviceSeq || 0)
    if (effectiveProcessedThrough > 0 && seq > 0 && seq <= effectiveProcessedThrough) continue
    const evTime = Number(ev.effectiveAt || ev.occurredAt || 0)
    if (!evTime || (now - evTime) <= MS_PER_DAY) {
      if (ev.repoId != null) recentUnprocessedKeys.add(String(ev.repoId))
      if (ev.canonicalKey) recentUnprocessedKeys.add(String(ev.canonicalKey).toLowerCase())
      if (ev.fullName) recentUnprocessedKeys.add(String(ev.fullName).toLowerCase())
    }
  }

  const scored = []
  const seenKeys = new Set()

  for (const rawCand of (candidates || [])) {
    if (!rawCand) continue
    const cand = extractRepositoryFeatures(rawCand, sharedVocabulary, effectiveFeatureSpace)
    const key = cand.repoId || cand.canonicalKey
    if (!key || seenKeys.has(key)) continue

    // 排除私有、已归档、已隐藏及本人仓库
    if (
      cand.visibility === 'private' ||
      cand.isPrivate === true ||
      cand.isArchived === true ||
      (cand.repoId && hiddenSet.has(String(cand.repoId))) ||
      (cand.canonicalKey && hiddenSet.has(cand.canonicalKey)) ||
      (cand.repoId && ownedSet.has(String(cand.repoId))) ||
      (cand.canonicalKey && ownedSet.has(cand.canonicalKey))
    ) {
      continue
    }

    seenKeys.add(key)

    const histEntry = historyMap.get(cand.canonicalKey) || (cand.repoId ? historyMap.get(String(cand.repoId)) : null)
    const openedFromHistory = Boolean(
      histEntry && (
        !histEntry.lastViewedAt ||
        (now - Number(histEntry.lastViewedAt)) <= MS_PER_DAY
      )
    )
    const openedFromIncrement = Boolean(
      (cand.repoId && recentUnprocessedKeys.has(String(cand.repoId))) ||
      (cand.canonicalKey && recentUnprocessedKeys.has(String(cand.canonicalKey).toLowerCase())) ||
      (cand.fullName && recentUnprocessedKeys.has(String(cand.fullName).toLowerCase()))
    )
    const openedRecent = openedFromHistory || openedFromIncrement

    const { baseScore, parts } = scoreCandidate(activeProfile, cand, now, openedRecent, {
      featureSpace: effectiveFeatureSpace,
      recentIncrement
    })
    const reasons = buildRecommendationReasons(activeProfile, cand, parts)

    scored.push({
      candidate: cand,
      baseScore,
      reasons,
      scoreParts: parts
    })
  }

  // MMR 重排与滑动窗口多样性约束
  const ranked = rerankCandidates(scored, 100, seed)

  const reverseSpace = effectiveFeatureSpace ? buildReverseFeatureSpace(effectiveFeatureSpace) : null
  const items = ranked.map((item, index) => ({
    batchId,
    position: index + 1,
    repoId: item.candidate.repoId || item.candidate.canonicalKey,
    score: item.baseScore,
    reasons: item.reasons,
    repository: {
      ...item.candidate,
      keywordWeights: extractProjectKeywordWeights(item.candidate, { reverseSpace })
    }
  }))

  const activeModelVersion =
    profile?.modelVersion ||
    innerProfile?.modelVersion ||
    effectiveFeatureSpace?.modelVersion ||
    'content-v1'

  return {
    batchId,
    accountId,
    modelVersion: activeModelVersion,
    featureSpaceVersion:
      profile?.featureSpaceVersion ||
      innerProfile?.featureSpaceVersion ||
      effectiveFeatureSpace?.featureSpaceVersion ||
      null,
    generationId: profile?.generationId || innerProfile?.generationId || null,
    processedThrough: effectiveProcessedThrough,
    unprocessedEventCount: recentIncrement ? recentIncrement.eventCount : 0,
    inputVersions,
    createdAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,
    items
  }
}

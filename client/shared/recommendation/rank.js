/**
 * shared/recommendation/rank.js
 * 候选项目评分、MMR 多样性重排与解释生成 (依据 project.md 第九节)
 */

import { buildVocabulary, extractRepositoryFeatures } from './features.js'
import { buildInterestProfile } from './profile.js'

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

function getCandidateVector(profile, candidate) {
  if (!candidate) return null
  if (candidate.vector && typeof candidate.vector === 'object' && Object.keys(candidate.vector).length > 0) {
    if (!profile?.vocabulary || !candidate.vocabularyVersion || candidate.vocabularyVersion === profile.vocabulary.version) {
      return candidate.vector
    }
  }
  if (profile?.vocabulary) {
    const extracted = extractRepositoryFeatures(candidate, profile.vocabulary)
    return extracted.vector
  }
  return candidate.vector || null
}

export function scoreCandidate(profile, candidate, now = Date.now(), openedRecent = false) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000

  // 1. 语言相似度
  let languageSimilarity = null
  const hasProfileLangs = profile?.languages && Object.keys(profile.languages).length > 0
  if (candidate.primaryLanguage && hasProfileLangs) {
    languageSimilarity = profile.languages[candidate.primaryLanguage] || 0
  }

  // 2. Topic 相似度 (候选 topic 在用户偏好分布中的权重均值)
  let topicSimilarity = null
  const hasProfileTopics = profile?.topics && Object.keys(profile.topics).length > 0
  if (Array.isArray(candidate.topics) && candidate.topics.length > 0 && hasProfileTopics) {
    let sum = 0
    let matches = 0
    for (const t of candidate.topics) {
      const clean = String(t).toLowerCase()
      if (profile.topics[clean]) {
        sum += profile.topics[clean]
        matches++
      }
    }
    topicSimilarity = matches > 0 ? (sum / matches) : 0
  }

  // 3. 文本向量余弦相似度 (同词表 L2 向量点积)
  let textCosine = null
  const candidateVector = getCandidateVector(profile, candidate)
  const profileVector = profile?.vector
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

  // 综合兴趣得分 (30% 语言, 35% Topic, 35% 文本)
  const hasAnyInterestSignal = (languageSimilarity !== null) || (topicSimilarity !== null) || (textCosine !== null)
  const interestScore = hasAnyInterestSignal
    ? weightedAvailable([
        { value: languageSimilarity, weight: 0.30 },
        { value: topicSimilarity, weight: 0.35 },
        { value: textCosine, weight: 0.35 }
      ])
    : null

  // 4. 新鲜度 Freshness
  let freshness = null
  if (candidate.updatedAt) {
    const daysSinceUpdate = Math.max(0, (now - candidate.updatedAt) / MS_PER_DAY)
    freshness = Math.pow(2, -daysSinceUpdate / 180)
  }

  // 5. 受欢迎程度 Popularity
  let popularity = null
  if (candidate.starCount !== null && candidate.starCount !== undefined) {
    popularity = Math.min(Math.log(1 + Math.max(0, candidate.starCount)) / Math.log(10001), 1)
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
      textCosine,
      freshness,
      popularity,
      info,
      trend,
      matchedLang: languageSimilarity > 0 ? candidate.primaryLanguage : null,
      matchedTopics: (candidate.topics || []).filter(t => profile?.topics?.[String(t).toLowerCase()])
    }
  }
}

export function buildRecommendationReasons(profile, candidate, scoreParts) {
  const reasons = []
  if (scoreParts?.matchedTopics?.length > 0) {
    reasons.push(`匹配你关注的技术标签 #${scoreParts.matchedTopics[0]}`)
  }
  if (scoreParts?.matchedLang) {
    reasons.push(`与你常用的 ${scoreParts.matchedLang} 生态相关`)
  }
  if (reasons.length === 0 && scoreParts?.textCosine > 0.25) {
    reasons.push('项目技术说明与你的本机兴趣方向相近')
  }
  if (reasons.length === 0 && scoreParts?.popularity > 0.7) {
    reasons.push('近期高关注度开源热门项目')
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

  if (a.vector && b.vector) {
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
  ownedSet = new Set()
}) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000
  const evidenceRepos = Array.isArray(profile?.evidenceRepos) ? profile.evidenceRepos : []

  // 构建统一的同构词表，确保 profile.vector 与 candidate.vector 处于同一特征空间
  const sharedVocabulary = buildVocabulary([...evidenceRepos, ...(candidates || [])])
  let activeProfile = profile
  if (activeProfile) {
    const needsReproject =
      !activeProfile.vector ||
      Object.keys(activeProfile.vector).length === 0 ||
      !activeProfile.vocabulary ||
      activeProfile.vocabulary.terms?.length !== sharedVocabulary.terms?.length
    if (needsReproject && evidenceRepos.length > 0) {
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

  const scored = []
  const seenKeys = new Set()

  for (const rawCand of (candidates || [])) {
    if (!rawCand) continue
    const cand = extractRepositoryFeatures(rawCand, sharedVocabulary)
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
    const openedRecent = Boolean(
      histEntry && (
        !histEntry.lastViewedAt ||
        (now - Number(histEntry.lastViewedAt)) <= MS_PER_DAY
      )
    )

    const { baseScore, parts } = scoreCandidate(activeProfile, cand, now, openedRecent)
    const reasons = buildRecommendationReasons(activeProfile, cand, parts)

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

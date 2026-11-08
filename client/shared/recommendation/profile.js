/**
 * shared/recommendation/profile.js
 * 本地兴趣画像计算与来源权重叠加 (依据 project.md 第九节)
 */

import { buildVocabulary, extractRepositoryFeatures, tokenizeText } from './features.js'

function resolveRepoKey(repo) {
  if (!repo) return null
  if (repo.canonicalKey) return String(repo.canonicalKey).toLowerCase()
  if (repo.fullName) return String(repo.fullName).toLowerCase()
  if (repo.owner && repo.name) return `${repo.owner}/${repo.name}`.toLowerCase()
  if (repo.repoId !== undefined && repo.repoId !== null) return String(repo.repoId)
  return null
}

export function buildInterestProfile({
  accountId,
  starred = [],
  owned = [],
  history = [],
  manualTags = [],
  hiddenRepoIds = [],
  historyEnabled = true,
  now = Date.now(),
  inputVersions = {},
  vocabulary = null,
  candidates = []
} = {}) {
  const hiddenSet = new Set((hiddenRepoIds || []).map(id => String(id)))
  const MS_PER_DAY = 24 * 60 * 60 * 1000

  function isHidden(r) {
    if (!r) return true
    if (r.repoId !== undefined && r.repoId !== null && hiddenSet.has(String(r.repoId))) return true
    const key = resolveRepoKey(r)
    if (key && hiddenSet.has(key)) return true
    return false
  }

  // 1. 合并所有证据仓库并计算每个仓库的综合权重
  const repoEvidenceMap = new Map() // key -> { repo, weight, evidence: string[] }

  // 1.1 统计 Star (weight = 3.0)
  for (const r of (starred || [])) {
    const key = resolveRepoKey(r)
    if (!key || isHidden(r)) continue
    repoEvidenceMap.set(key, {
      repo: r,
      weight: 3.0,
      evidence: ['star']
    })
  }

  // 1.2 统计本人公开仓库 (weight = 1.5)
  for (const r of (owned || [])) {
    const key = resolveRepoKey(r)
    if (!key || isHidden(r)) continue
    if (repoEvidenceMap.has(key)) {
      const existing = repoEvidenceMap.get(key)
      existing.weight += 1.5
      if (!existing.evidence.includes('owned')) existing.evidence.push('owned')
    } else {
      repoEvidenceMap.set(key, {
        repo: r,
        weight: 1.5,
        evidence: ['owned']
      })
    }
  }

  // 1.3 统计历史记录 (若开启 historyEnabled)
  if (historyEnabled) {
    for (const h of (history || [])) {
      const r = h?.repository || h
      const key = resolveRepoKey(r)
      if (!key || isHidden(r)) continue

      const visitCount = Math.max(1, Number(h?.visitCount || 1))
      const lastViewedAt = Number(h?.lastViewedAt || now)
      const daysSinceLastOpen = Math.max(0, (now - lastViewedAt) / MS_PER_DAY)
      // historyWeight = min(1 + ln(visitCount), 3) * 2^(-daysSinceLastOpen / 30)
      const countFactor = Math.min(1 + Math.log(visitCount), 3)
      const decayFactor = Math.pow(2, -daysSinceLastOpen / 30)
      const historyWeight = countFactor * decayFactor

      if (repoEvidenceMap.has(key)) {
        const existing = repoEvidenceMap.get(key)
        existing.weight += historyWeight
        if (!existing.evidence.includes('history')) existing.evidence.push('history')
      } else {
        repoEvidenceMap.set(key, {
          repo: r,
          weight: historyWeight,
          evidence: ['history']
        })
      }
    }
  }

  // 1.4 准备共享词表，确保画像向量与候选向量同构
  const evidenceEntries = Array.from(repoEvidenceMap.values())
  const activeVocabulary = vocabulary || buildVocabulary([
    ...evidenceEntries.map(e => e.repo),
    ...(candidates || [])
  ])

  // 2. 统计语言、Topic 分布与聚合文本兴趣向量
  const languageScores = new Map()
  const topicScores = new Map()
  const topicEvidenceRepos = new Map()
  const rawVector = {}
  const evidenceRepos = []

  for (const entry of evidenceEntries) {
    const { weight, evidence } = entry
    const enrichedRepo = (entry.repo.vector && Object.keys(entry.repo.vector).length > 0 && !vocabulary)
      ? entry.repo
      : extractRepositoryFeatures(entry.repo, activeVocabulary)

    entry.repo = enrichedRepo

    if (enrichedRepo.primaryLanguage && enrichedRepo.primaryLanguage !== '未标注') {
      const lang = enrichedRepo.primaryLanguage.trim()
      languageScores.set(lang, (languageScores.get(lang) || 0) + weight)
    }

    const repoIdentifier = enrichedRepo.repoId || enrichedRepo.fullName || enrichedRepo.canonicalKey
    for (const t of enrichedRepo.topics || []) {
      const cleanTopic = String(t).trim().toLowerCase()
      if (!cleanTopic) continue
      topicScores.set(cleanTopic, (topicScores.get(cleanTopic) || 0) + weight)

      if (!topicEvidenceRepos.has(cleanTopic)) {
        topicEvidenceRepos.set(cleanTopic, [])
      }
      const list = topicEvidenceRepos.get(cleanTopic)
      if (repoIdentifier && list.length < 5 && !list.includes(repoIdentifier)) {
        list.push(repoIdentifier)
      }
    }

    // 累加仓库文本向量
    if (enrichedRepo.vector && typeof enrichedRepo.vector === 'object') {
      for (const [term, val] of Object.entries(enrichedRepo.vector)) {
        if (Number.isFinite(val) && val > 0) {
          rawVector[term] = (rawVector[term] || 0) + val * weight
        }
      }
    }

    evidenceRepos.push({
      repoId: enrichedRepo.repoId,
      canonicalKey: enrichedRepo.canonicalKey,
      fullName: enrichedRepo.fullName,
      owner: enrichedRepo.owner,
      name: enrichedRepo.name,
      description: enrichedRepo.description,
      readmeText: enrichedRepo.readmeText,
      primaryLanguage: enrichedRepo.primaryLanguage,
      topics: enrichedRepo.topics,
      starCount: enrichedRepo.starCount,
      forkCount: enrichedRepo.forkCount,
      updatedAt: enrichedRepo.updatedAt,
      weight: parseFloat(weight.toFixed(4)),
      sources: evidence
    })
  }

  // 3. 叠加手选技术标签 (manualTagWeight = 4.0)
  for (const tag of (manualTags || [])) {
    const clean = String(tag).trim().toLowerCase()
    if (!clean) continue
    topicScores.set(clean, (topicScores.get(clean) || 0) + 4.0)

    const idfMap = activeVocabulary?.idfMap || {}
    if (idfMap[clean]) {
      rawVector[clean] = (rawVector[clean] || 0) + 4.0 * idfMap[clean]
    } else {
      for (const tok of tokenizeText(clean)) {
        if (idfMap[tok]) {
          rawVector[tok] = (rawVector[tok] || 0) + 4.0 * idfMap[tok]
        }
      }
    }
  }

  // L2 归一化用户兴趣文本向量
  const vector = {}
  let vecNormSq = 0
  for (const val of Object.values(rawVector)) {
    vecNormSq += val * val
  }
  const vecNorm = Math.sqrt(vecNormSq)
  if (vecNorm > 0) {
    for (const [term, val] of Object.entries(rawVector)) {
      vector[term] = val / vecNorm
    }
  }

  // 归一化语言与 Topic
  const languages = {}
  let totalLang = 0
  for (const v of languageScores.values()) totalLang += v
  if (totalLang > 0) {
    for (const [k, v] of languageScores.entries()) {
      languages[k] = parseFloat((v / totalLang).toFixed(4))
    }
  }

  const topics = {}
  let totalTopic = 0
  for (const v of topicScores.values()) totalTopic += v
  if (totalTopic > 0) {
    for (const [k, v] of topicScores.entries()) {
      topics[k] = parseFloat((v / totalTopic).toFixed(4))
    }
  }

  // 4. 提取前 8 个主要兴趣标签与支撑证据
  const sortedTopics = Array.from(topicScores.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)

  const topInterests = sortedTopics.map(([tag, score]) => ({
    tag,
    score: parseFloat(score.toFixed(2)),
    evidenceRepos: topicEvidenceRepos.get(tag) || []
  }))

  return {
    accountId,
    languages,
    topics,
    manualTags,
    topInterests,
    vector,
    vocabularyVersion: activeVocabulary?.version || 'vocab-v1',
    vocabulary: activeVocabulary,
    evidenceRepos,
    generatedAt: now,
    inputVersions
  }
}

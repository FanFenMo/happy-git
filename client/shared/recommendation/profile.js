/**
 * shared/recommendation/profile.js
 * 本地兴趣画像计算与来源权重叠加 (依据 project.md 第九节)
 */

export function buildInterestProfile({
  accountId,
  starred = [],
  owned = [],
  history = [],
  manualTags = [],
  hiddenRepoIds = [],
  historyEnabled = true,
  now = Date.now(),
  inputVersions = {}
}) {
  const hiddenSet = new Set(hiddenRepoIds || [])
  const MS_PER_DAY = 24 * 60 * 60 * 1000

  // 1. 合并所有证据仓库并计算每个仓库的综合权重
  const repoEvidenceMap = new Map() // canonicalKey -> { repo, weight, evidence: string[] }

  // 1.1 统计 Star (weight = 3.0)
  for (const r of starred) {
    if (!r || !r.canonicalKey || hiddenSet.has(r.repoId)) continue
    repoEvidenceMap.set(r.canonicalKey, {
      repo: r,
      weight: 3.0,
      evidence: ['star']
    })
  }

  // 1.2 统计本人公开仓库 (weight = 1.5)
  for (const r of owned) {
    if (!r || !r.canonicalKey || hiddenSet.has(r.repoId)) continue
    if (repoEvidenceMap.has(r.canonicalKey)) {
      const existing = repoEvidenceMap.get(r.canonicalKey)
      existing.weight += 1.5
      existing.evidence.push('owned')
    } else {
      repoEvidenceMap.set(r.canonicalKey, {
        repo: r,
        weight: 1.5,
        evidence: ['owned']
      })
    }
  }

  // 1.3 统计历史记录 (若开启 historyEnabled)
  if (historyEnabled) {
    for (const h of history) {
      const r = h.repository || h
      if (!r || !r.canonicalKey || hiddenSet.has(r.repoId)) continue

      const visitCount = h.visitCount || 1
      const lastViewedAt = h.lastViewedAt || now
      const daysSinceLastOpen = Math.max(0, (now - lastViewedAt) / MS_PER_DAY)
      // historyWeight = min(1 + ln(visitCount), 3) * 2^(-daysSinceLastOpen / 30)
      const countFactor = Math.min(1 + Math.log(visitCount), 3)
      const decayFactor = Math.pow(2, -daysSinceLastOpen / 30)
      const historyWeight = countFactor * decayFactor

      if (repoEvidenceMap.has(r.canonicalKey)) {
        const existing = repoEvidenceMap.get(r.canonicalKey)
        existing.weight += historyWeight
        existing.evidence.push('history')
      } else {
        repoEvidenceMap.set(r.canonicalKey, {
          repo: r,
          weight: historyWeight,
          evidence: ['history']
        })
      }
    }
  }

  // 2. 统计语言与 Topic 分布
  const languageScores = new Map()
  const topicScores = new Map()
  const topicEvidenceRepos = new Map()

  for (const { repo, weight } of repoEvidenceMap.values()) {
    if (repo.primaryLanguage && repo.primaryLanguage !== '未标注') {
      const lang = repo.primaryLanguage.trim()
      languageScores.set(lang, (languageScores.get(lang) || 0) + weight)
    }

    for (const t of repo.topics || []) {
      const cleanTopic = t.trim().toLowerCase()
      if (!cleanTopic) continue
      topicScores.set(cleanTopic, (topicScores.get(cleanTopic) || 0) + weight)

      if (!topicEvidenceRepos.has(cleanTopic)) {
        topicEvidenceRepos.set(cleanTopic, [])
      }
      const list = topicEvidenceRepos.get(cleanTopic)
      if (list.length < 5) list.push(repo.fullName || repo.canonicalKey)
    }
  }

  // 3. 叠加手选技术标签 (manualTagWeight = 4.0)
  for (const tag of manualTags) {
    const clean = String(tag).trim().toLowerCase()
    if (!clean) continue
    topicScores.set(clean, (topicScores.get(clean) || 0) + 4.0)
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
    .sort((a, b) => b[1] - a[1])
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
    generatedAt: now,
    inputVersions
  }
}

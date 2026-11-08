/**
 * shared/recommendation/recall.js
 * 从技术画像生成结构化 GitHub 发现查询计划 (依据 project.md 第九节)
 */

function attachQueryPlanContract(list, now) {
  Object.defineProperty(list, 'queryPlan', {
    value: list,
    enumerable: false,
    configurable: true
  })
  Object.defineProperty(list, 'generatedAt', {
    value: now,
    enumerable: false,
    configurable: true
  })
  return list
}

export function planDiscoveryQueries(profile, recentQueries = [], now = Date.now()) {
  const queries = []
  if (!profile) return attachQueryPlanContract([], now)

  const recentSet = new Set(
    (Array.isArray(recentQueries) ? recentQueries : [])
      .map(q => (typeof q === 'string' ? q.trim() : q?.query?.trim()))
      .filter(Boolean)
  )

  const topTopics = (profile.topInterests || []).map(i => i.tag).filter(Boolean).slice(0, 6)
  const topLanguages = Object.entries(profile.languages || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lang]) => lang)
    .filter(Boolean)
    .slice(0, 3)

  const candidates = []

  // 1. 主要兴趣 Topic + 主要语言组合
  if (topTopics.length > 0) {
    const mainTopic = topTopics[0]
    const mainLang = topLanguages[0] || null
    let q = `topic:${mainTopic} archived:false is:public`
    if (mainLang) {
      q += ` language:${mainLang}`
    }
    candidates.push({
      id: `query_topic_${mainTopic}`,
      query: q,
      sort: 'stars',
      topics: [mainTopic],
      keywords: [],
      language: mainLang,
      profileInputVersions: profile.inputVersions || {}
    })
  }

  // 2. 次要兴趣 Topic 组合
  if (topTopics.length > 1) {
    const secondTopic = topTopics[1]
    candidates.push({
      id: `query_topic_${secondTopic}`,
      query: `topic:${secondTopic} archived:false is:public`,
      sort: 'updated',
      topics: [secondTopic],
      keywords: [],
      language: null,
      profileInputVersions: profile.inputVersions || {}
    })
  }

  // 3. 第三或手选标签组合
  if (topTopics.length > 2) {
    const thirdTopic = topTopics[2]
    candidates.push({
      id: `query_topic_${thirdTopic}`,
      query: `topic:${thirdTopic} archived:false is:public`,
      sort: 'stars',
      topics: [thirdTopic],
      keywords: [],
      language: null,
      profileInputVersions: profile.inputVersions || {}
    })
  }

  // 4. 第四兴趣 Topic 组合（若存在）
  if (topTopics.length > 3) {
    const fourthTopic = topTopics[3]
    candidates.push({
      id: `query_topic_${fourthTopic}`,
      query: `topic:${fourthTopic} archived:false is:public`,
      sort: 'updated',
      topics: [fourthTopic],
      keywords: [],
      language: null,
      profileInputVersions: profile.inputVersions || {}
    })
  }

  // 5. 基于主要语言与趋势的查询
  for (const lang of topLanguages) {
    candidates.push({
      id: `query_lang_${lang}`,
      query: `language:${lang} stars:>500 archived:false is:public`,
      sort: 'stars',
      topics: [],
      keywords: [],
      language: lang,
      profileInputVersions: profile.inputVersions || {}
    })
  }

  // 优先选择未出现在 recentQueries 中的查询，不足时回填
  const deferred = []
  for (const item of candidates) {
    if (queries.length >= 4) break
    if (recentSet.has(item.query)) {
      deferred.push(item)
    } else if (!queries.some(existing => existing.query === item.query)) {
      queries.push(item)
    }
  }

  for (const item of deferred) {
    if (queries.length >= 4) break
    if (!queries.some(existing => existing.query === item.query)) {
      queries.push(item)
    }
  }

  return attachQueryPlanContract(queries.slice(0, 4), now)
}

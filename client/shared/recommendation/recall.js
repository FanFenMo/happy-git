/**
 * shared/recommendation/recall.js
 * 从云端搜索计划或技术画像生成有界结构化 GitHub 发现查询计划
 * (依据 project.md 第九节、接口与模型契约及第二轮画像驱动搜索规范)
 */

const SAFE_SEARCH_TOKEN = /^[a-zA-Z0-9_+.#\u4e00-\u9fff-]{1,48}$/

export function sanitizeSearchToken(raw) {
  if (raw === null || raw === undefined) return ''
  const str = String(raw).trim()
  if (!str) return ''
  // 拒绝包含 URL 协议、脚本符号或引号注入的片段
  if (/https?:\/\/|<|>|javascript:|["';\\]/i.test(str)) {
    return ''
  }
  return SAFE_SEARCH_TOKEN.test(str) ? str : ''
}

/**
 * 根据固定规则将结构化条件构建为安全的 GitHub 仓库搜索查询串
 */
export function buildGitHubSearchQuery(spec = {}) {
  if (!spec || typeof spec !== 'object') {
    return 'archived:false is:public'
  }

  const parts = []
  const topics = Array.isArray(spec.topics) ? spec.topics : []
  for (const t of topics.slice(0, 3)) {
    const clean = sanitizeSearchToken(t).toLowerCase()
    if (clean) parts.push(`topic:${clean}`)
  }

  const lang = sanitizeSearchToken(spec.language)
  if (lang) {
    parts.push(`language:${lang}`)
  }

  const keywords = Array.isArray(spec.keywords) ? spec.keywords : []
  for (const kw of keywords.slice(0, 3)) {
    const clean = sanitizeSearchToken(kw)
    if (clean && !parts.includes(`topic:${clean.toLowerCase()}`)) {
      parts.push(clean)
    }
  }

  const exclusions = spec.exclusions && typeof spec.exclusions === 'object' ? spec.exclusions : {}
  const excludeTopics = Array.isArray(spec.excludeTopics)
    ? spec.excludeTopics
    : (Array.isArray(exclusions.excludeTopics) ? exclusions.excludeTopics : [])
  for (const ex of excludeTopics.slice(0, 3)) {
    const clean = sanitizeSearchToken(ex).toLowerCase()
    if (clean) parts.push(`-topic:${clean}`)
  }

  if (exclusions.minStars && Number.isFinite(Number(exclusions.minStars)) && Number(exclusions.minStars) > 0) {
    parts.push(`stars:>${Math.floor(Number(exclusions.minStars))}`)
  } else if (parts.length === 1 && parts[0].startsWith('language:')) {
    parts.push('stars:>500')
  }

  if (exclusions.fork === false || spec.excludeForks === true) {
    parts.push('fork:false')
  }

  parts.push('archived:false')
  parts.push('is:public')

  return parts.join(' ')
}

function attachQueryPlanContract(list, now, meta = {}) {
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
  Object.defineProperty(list, 'bounded', {
    value: true,
    enumerable: false,
    configurable: true
  })
  Object.defineProperty(list, 'complete', {
    value: false,
    enumerable: false,
    configurable: true
  })
  Object.defineProperty(list, 'maxQueries', {
    value: meta.maxQueries || 4,
    enumerable: false,
    configurable: true
  })
  Object.defineProperty(list, 'maxTotalPages', {
    value: meta.maxTotalPages || 8,
    enumerable: false,
    configurable: true
  })
  Object.defineProperty(list, 'modelVersion', {
    value: meta.modelVersion || null,
    enumerable: false,
    configurable: true
  })
  Object.defineProperty(list, 'featureSpaceVersion', {
    value: meta.featureSpaceVersion || null,
    enumerable: false,
    configurable: true
  })
  Object.defineProperty(list, 'generationId', {
    value: meta.generationId || null,
    enumerable: false,
    configurable: true
  })
  return list
}

/**
 * 从云端 search-plan / portrait 或本地画像生成有界查询计划：
 * 默认一次最多 4 个查询、总计最多 8 页，不将有限结果页声称为全站检索完成。
 */
export function planDiscoveryQueries(profile, recentQueries = [], now = Date.now(), options = {}) {
  const maxQueries = Math.min(4, Math.max(1, Number(options.maxQueries || 4)))
  const maxTotalPages = Math.min(8, Math.max(1, Number(options.maxTotalPages || 8)))
  const pageCursors = options.pageCursors && typeof options.pageCursors === 'object' ? options.pageCursors : {}

  const queries = []
  if (!profile) {
    return attachQueryPlanContract([], now, { maxQueries, maxTotalPages })
  }

  const recentSet = new Set(
    (Array.isArray(recentQueries) ? recentQueries : [])
      .map(q => (typeof q === 'string' ? q.trim() : q?.query?.trim()))
      .filter(Boolean)
  )

  const modelVersion = profile.modelVersion || profile.profile?.modelVersion || null
  const featureSpaceVersion = profile.featureSpaceVersion || profile.profile?.featureSpaceVersion || null
  const generationId = profile.generationId || profile.profile?.generationId || null
  const innerProfile = profile.profile && typeof profile.profile === 'object' ? profile.profile : profile
  const inputVersions = profile.inputVersions || innerProfile.inputVersions || {}

  const candidates = []

  // 0. 若输入直接包含服务端同代结构化 searchPlan.queries，则按固定安全规则转换
  const rawServerQueries = Array.isArray(profile.queries)
    ? profile.queries
    : (Array.isArray(profile.searchPlan?.queries) ? profile.searchPlan.queries : [])

  for (let i = 0; i < rawServerQueries.length; i++) {
    const sq = rawServerQueries[i]
    if (!sq || typeof sq !== 'object') continue
    const topics = (Array.isArray(sq.topics) ? sq.topics : []).map(sanitizeSearchToken).filter(Boolean)
    const keywords = (Array.isArray(sq.keywords) ? sq.keywords : []).map(sanitizeSearchToken).filter(Boolean)
    const language = sanitizeSearchToken(sq.language) || null
    if (topics.length === 0 && keywords.length === 0 && !language) continue

    const sort = sq.sort === 'updated' ? 'updated' : 'stars'
    const queryStr = buildGitHubSearchQuery({
      topics,
      language,
      keywords,
      exclusions: sq.exclusions,
      excludeTopics: sq.excludeTopics
    })
    const queryId = sanitizeSearchToken(sq.id || sq.directionId) || `query_server_${i + 1}`
    candidates.push({
      id: queryId,
      directionId: sq.directionId || null,
      label: sq.label || topics[0] || keywords[0] || language || queryId,
      query: queryStr,
      sort,
      topics,
      keywords,
      language,
      exclusions: sq.exclusions || { archived: false, isPublic: true },
      modelVersion,
      featureSpaceVersion,
      generationId,
      profileInputVersions: inputVersions
    })
  }

  // 1. 若画像包含学习到的兴趣方向 directions，优先将高权重方向转换为结构化查询
  const directions = Array.isArray(innerProfile.directions) ? innerProfile.directions : []
  for (const dir of directions.slice(0, 4)) {
    if (!dir || typeof dir !== 'object') continue
    const dirTopics = (Array.isArray(dir.topics) ? dir.topics : []).map(sanitizeSearchToken).filter(Boolean).slice(0, 2)
    const dirLangs = (Array.isArray(dir.languages) ? dir.languages : []).map(sanitizeSearchToken).filter(Boolean)
    const dirTerms = (Array.isArray(dir.topTerms) ? dir.topTerms : (Array.isArray(dir.keywords) ? dir.keywords : []))
      .map(sanitizeSearchToken)
      .filter(Boolean)
      .slice(0, 2)
    if (dirTopics.length === 0 && dirLangs.length === 0 && dirTerms.length === 0) continue

    const mainLang = dirLangs[0] || null
    const queryStr = buildGitHubSearchQuery({
      topics: dirTopics,
      language: mainLang,
      keywords: dirTopics.length === 0 ? dirTerms : dirTerms.slice(0, 1)
    })
    const dirId = sanitizeSearchToken(dir.directionId || dir.id) || `dir_${dirTopics[0] || mainLang || 'interest'}`
    candidates.push({
      id: `query_${dirId}`,
      directionId: dir.directionId || dir.id || null,
      label: dir.label || dirTopics[0] || mainLang || dirId,
      query: queryStr,
      sort: 'stars',
      topics: dirTopics,
      keywords: dirTerms,
      language: mainLang,
      exclusions: { archived: false, isPublic: true },
      modelVersion,
      featureSpaceVersion,
      generationId,
      profileInputVersions: inputVersions
    })
  }

  const topTopics = (innerProfile.topInterests || [])
    .map(i => sanitizeSearchToken(i?.tag || i))
    .filter(Boolean)
    .slice(0, 6)
  const topLanguages = Object.entries(innerProfile.languages || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lang]) => sanitizeSearchToken(lang))
    .filter(Boolean)
    .slice(0, 3)

  // 2. 主要兴趣 Topic + 主要语言组合
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
      exclusions: { archived: false, isPublic: true },
      modelVersion,
      featureSpaceVersion,
      generationId,
      profileInputVersions: inputVersions
    })
  }

  // 3. 次要兴趣 Topic 组合
  if (topTopics.length > 1) {
    const secondTopic = topTopics[1]
    candidates.push({
      id: `query_topic_${secondTopic}`,
      query: `topic:${secondTopic} archived:false is:public`,
      sort: 'updated',
      topics: [secondTopic],
      keywords: [],
      language: null,
      exclusions: { archived: false, isPublic: true },
      modelVersion,
      featureSpaceVersion,
      generationId,
      profileInputVersions: inputVersions
    })
  }

  // 4. 第三或手选标签组合
  if (topTopics.length > 2) {
    const thirdTopic = topTopics[2]
    candidates.push({
      id: `query_topic_${thirdTopic}`,
      query: `topic:${thirdTopic} archived:false is:public`,
      sort: 'stars',
      topics: [thirdTopic],
      keywords: [],
      language: null,
      exclusions: { archived: false, isPublic: true },
      modelVersion,
      featureSpaceVersion,
      generationId,
      profileInputVersions: inputVersions
    })
  }

  // 5. 第四兴趣 Topic 组合（若存在）
  if (topTopics.length > 3) {
    const fourthTopic = topTopics[3]
    candidates.push({
      id: `query_topic_${fourthTopic}`,
      query: `topic:${fourthTopic} archived:false is:public`,
      sort: 'updated',
      topics: [fourthTopic],
      keywords: [],
      language: null,
      exclusions: { archived: false, isPublic: true },
      modelVersion,
      featureSpaceVersion,
      generationId,
      profileInputVersions: inputVersions
    })
  }

  // 6. 基于主要语言与趋势的查询
  for (const lang of topLanguages) {
    candidates.push({
      id: `query_lang_${lang}`,
      query: `language:${lang} stars:>500 archived:false is:public`,
      sort: 'stars',
      topics: [],
      keywords: [],
      language: lang,
      exclusions: { archived: false, isPublic: true, minStars: 500 },
      modelVersion,
      featureSpaceVersion,
      generationId,
      profileInputVersions: inputVersions
    })
  }

  // 优先选择未出现在 recentQueries 中的查询，不足时回填
  const deferred = []
  for (const item of candidates) {
    if (queries.length >= maxQueries) break
    if (recentSet.has(item.query)) {
      deferred.push(item)
    } else if (!queries.some(existing => existing.query === item.query)) {
      queries.push(item)
    }
  }

  for (const item of deferred) {
    if (queries.length >= maxQueries) break
    if (!queries.some(existing => existing.query === item.query)) {
      queries.push(item)
    }
  }

  // 分配每条查询的页数预算，确保单轮总页数 <= maxTotalPages (默认 8 页)
  const selected = queries.slice(0, maxQueries)
  let remainingPages = maxTotalPages
  for (let i = 0; i < selected.length; i++) {
    const q = selected[i]
    const slotsLeft = selected.length - i
    const pagesForQuery = Math.max(1, Math.min(2, Math.floor(remainingPages / slotsLeft)))
    remainingPages = Math.max(0, remainingPages - pagesForQuery)
    const startPage = Math.max(1, Number(pageCursors[q.id] || q.startPage || 1))
    selected[i] = {
      ...q,
      startPage,
      maxPages: pagesForQuery
    }
  }

  return attachQueryPlanContract(selected, now, {
    maxQueries,
    maxTotalPages,
    modelVersion,
    featureSpaceVersion,
    generationId
  })
}

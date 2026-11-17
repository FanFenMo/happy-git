/**
 * shared/recommendation/features.js
 * 项目特征抽取、技术分词、词表拟合与服务端 8192 维特征空间同构投影
 * (依据 project.md 第九节、接口与模型契约及 data-platform Vectors.java)
 */

import { extractRepositoryEvidenceCues } from '../github-page/normalize.js'

export const SERVER_VECTOR_DIMENSION = 8192

const SERVER_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'in', 'is', 'with', 'this', 'that'
])

const SERVER_TOKEN_REGEX = /c\+\+|c#|\.net|node\.js|[a-z0-9]+|[\u4e00-\u9fff]{2,}/g

/**
 * 与 data-platform Vectors.tokens(text) 完全同构的 NFKC + 中文双字 Bigram 分词器
 */
export function tokenizeTechnicalNfkcBigram(text) {
  if (!text || typeof text !== 'string') return []
  const clean = text.normalize('NFKC').toLowerCase()
  const result = []
  const matches = clean.match(SERVER_TOKEN_REGEX) || []
  for (const term of matches) {
    if (/^[\u4e00-\u9fff]+$/.test(term)) {
      for (let i = 0; i + 1 < term.length; i++) {
        result.push(term.slice(i, i + 2))
      }
    } else if (!SERVER_STOPWORDS.has(term)) {
      result.push(term)
    }
  }
  return result
}

/**
 * 统计仓库词频（与 Vectors.terms 完全一致：name/description/topics 权重 2，readme 前 8000 码点权重 1）
 */
export function countRepositoryServerTerms(repository = {}) {
  const counts = new Map()
  const addCount = (str, weight) => {
    for (const term of tokenizeTechnicalNfkcBigram(str || '')) {
      counts.set(term, (counts.get(term) || 0) + weight)
    }
  }
  addCount(repository.name || '', 2)
  addCount(repository.description || '', 2)
  for (const topic of (Array.isArray(repository.topics) ? repository.topics : [])) {
    addCount(String(topic || ''), 2)
  }
  const rawReadme = typeof repository.readmeText === 'string' ? repository.readmeText : ''
  const clippedReadme = Array.from(rawReadme).slice(0, 8000).join('')
  addCount(clippedReadme, 1)
  return counts
}

/**
 * 将密集累加数组归一化为稀疏向量 { dimension: 8192, indices: number[], values: number[] }
 * 与 Vectors.normalize(sum, limit) 严格同构
 */
export function normalizeDenseToSparse(sum, limit = 256) {
  const coordinates = []
  for (let i = 0; i < sum.length; i++) {
    const val = sum[i]
    if (Number.isFinite(val) && val > 0) {
      coordinates.push(i)
    }
  }
  coordinates.sort((a, b) => {
    const diff = sum[b] - sum[a]
    if (Math.abs(diff) > 1e-15) return diff > 0 ? 1 : -1
    return a - b
  })
  const selected = coordinates.length > limit ? coordinates.slice(0, limit) : coordinates
  selected.sort((a, b) => a - b)

  let squared = 0
  for (const idx of selected) {
    squared += sum[idx] * sum[idx]
  }
  const indices = []
  const values = []
  if (squared > 0) {
    const norm = Math.sqrt(squared)
    for (const idx of selected) {
      indices.push(idx)
      values.push(sum[idx] / norm)
    }
  }
  return {
    dimension: SERVER_VECTOR_DIMENSION,
    indices,
    values
  }
}

export function addSparseVector(sum, sparseVector, weight = 1.0) {
  if (!sparseVector || typeof sparseVector !== 'object') return
  const indices = Array.isArray(sparseVector.indices) ? sparseVector.indices : []
  const values = Array.isArray(sparseVector.values) ? sparseVector.values : []
  if (indices.length !== values.length) return
  for (let p = 0; p < indices.length; p++) {
    const idx = Number(indices[p])
    const val = Number(values[p])
    if (Number.isInteger(idx) && idx >= 0 && idx < sum.length && Number.isFinite(val) && val > 0) {
      sum[idx] += weight * val
    }
  }
}

/**
 * 稀疏向量点积（与 Vectors.dot 完全同构）
 */
export function sparseDotProduct(a, b) {
  if (!a || !b || !Array.isArray(a.indices) || !Array.isArray(b.indices)) return null
  if (a.indices.length === 0 || b.indices.length === 0) return 0
  let i = 0
  let j = 0
  let sum = 0
  while (i < a.indices.length && j < b.indices.length) {
    const x = a.indices[i]
    const y = b.indices[j]
    if (x === y) {
      sum += (a.values[i] || 0) * (b.values[j] || 0)
      i++
      j++
    } else if (x < y) {
      i++
    } else {
      j++
    }
  }
  return Math.max(0, Math.min(1, sum))
}

/**
 * 使用服务端已发布 featureSpace 对任意仓库（含训练目录外新搜索项目）进行兼容投影。
 * 未知语言、未知 topic 和未知词项保持真实缺失，绝不编造向量坐标。
 */
export function projectRepositoryToFeatureSpace(repository, featureSpace) {
  if (!repository || !featureSpace || typeof featureSpace !== 'object') {
    return null
  }
  const sum = new Float64Array(SERVER_VECTOR_DIMENSION)
  const langMap = featureSpace.language || {}
  const topicMap = featureSpace.topic || {}
  const textMap = featureSpace.text || {}

  const primaryLanguage = repository.primaryLanguage || null
  let knownLanguage = false
  let unknownLanguage = null
  if (primaryLanguage && primaryLanguage !== '未标注') {
    const langIdx = langMap[primaryLanguage]
    if (Number.isInteger(langIdx) && langIdx >= 0 && langIdx < SERVER_VECTOR_DIMENSION) {
      sum[langIdx] = Math.sqrt(0.20)
      knownLanguage = true
    } else {
      unknownLanguage = primaryLanguage
    }
  }

  const topicWeights = new Map()
  const knownTopics = []
  const unknownTopics = []
  for (const rawTopic of (Array.isArray(repository.topics) ? repository.topics : [])) {
    const topic = String(rawTopic || '').trim()
    if (!topic) continue
    const topicIdx = topicMap[topic] ?? topicMap[topic.toLowerCase()]
    if (Number.isInteger(topicIdx) && topicIdx >= 0 && topicIdx < SERVER_VECTOR_DIMENSION) {
      topicWeights.set(topicIdx, 1.0)
      knownTopics.push(topic.toLowerCase())
    } else {
      unknownTopics.push(topic.toLowerCase())
    }
  }

  const termCounts = repository.counts && typeof repository.counts === 'object'
    ? new Map(Object.entries(repository.counts).map(([k, v]) => [k, Number(v)]))
    : countRepositoryServerTerms(repository)

  const textWeights = new Map()
  let knownTermCount = 0
  let unknownTermCount = 0
  for (const [term, count] of termCounts.entries()) {
    if (!Number.isFinite(count) || count <= 0) continue
    const entry = textMap[term]
    if (entry && typeof entry === 'object' && Number.isInteger(entry.index) && Number.isFinite(entry.idf)) {
      textWeights.set(entry.index, (1 + Math.log(count)) * entry.idf)
      knownTermCount++
    } else {
      unknownTermCount++
    }
  }

  const applyBlock = (blockMap, scale) => {
    let normSq = 0
    for (const v of blockMap.values()) normSq += v * v
    const norm = Math.sqrt(normSq)
    if (norm > 0) {
      for (const [idx, val] of blockMap.entries()) {
        sum[idx] = (scale * val) / norm
      }
    }
  }

  applyBlock(topicWeights, Math.sqrt(0.30))
  applyBlock(textWeights, Math.sqrt(0.50))

  const sparseVector = normalizeDenseToSparse(sum, 256)
  return {
    sparseVector,
    featureSpaceVersion: featureSpace.featureSpaceVersion || featureSpace.version || null,
    modelVersion: featureSpace.modelVersion || null,
    knownLanguage,
    knownTopics,
    knownTermCount,
    missingFeatures: {
      unknownLanguage,
      unknownTopics,
      unknownTermCount
    }
  }
}

// 预定义常见技术专有名词保留表（避免被拆散，例如 C++, C#, .NET）
const PRESERVED_TECH_TERMS = [
  'c++', 'c#', '.net', 'vue.js', 'vue', 'spring boot', 'spring', 'react', 'sqlite',
  'docker', 'kubernetes', 'k8s', 'pytorch', 'tensorflow', 'machine learning',
  'deep learning', 'android', 'electron', 'capacitor', 'nodejs', 'node.js',
  'typescript', 'javascript', 'python', 'golang', 'rust', 'java', 'kotlin',
  'swift', 'flutter', '3dgs', 'llm', 'transformer', 'redis', 'mysql', 'postgresql',
  'mongodb', 'graphql', 'rest api', 'hadoop', 'mapreduce', 'spark', 'kafka'
]

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'out', 'are',
  'was', 'were', 'have', 'has', 'had', 'not', 'but', 'you', 'your', 'can',
  'will', 'all', 'its', 'our', 'via', 'per', 'over', 'under', 'more', 'most'
])

export function tokenizeText(text) {
  if (!text || typeof text !== 'string') return []

  const raw = text.toLowerCase()
  const tokens = []
  let processed = raw

  // 1. 先提取保留的技术专有名词
  for (const term of PRESERVED_TECH_TERMS) {
    if (processed.includes(term)) {
      tokens.push(term)
      processed = processed.replaceAll(term, ' ')
    }
  }

  // 2. 匹配英文字词、数字及连字符词，过滤停用词
  const words = processed.match(/[a-z0-9_\u4e00-\u9fa5]{2,30}/g) || []
  for (const w of words) {
    if (w.length >= 2 && !STOPWORDS.has(w)) {
      tokens.push(w)
    }
  }

  return tokens
}

export function buildVocabulary(repositories = [], maxTerms = 5000) {
  const docFreq = new Map()
  const validRepos = Array.isArray(repositories) ? repositories.filter(Boolean) : []
  const N = validRepos.length

  for (const repo of validRepos) {
    const text = [
      repo.name,
      repo.description,
      (repo.topics || []).join(' '),
      (repo.readmeText || '').slice(0, 8000)
    ].filter(Boolean).join(' ')

    const words = new Set(tokenizeText(text))
    for (const w of words) {
      docFreq.set(w, (docFreq.get(w) || 0) + 1)
    }
  }

  // 按词频降序排序（同频按词项字典序稳定排序），选取前 maxTerms 个
  const sorted = Array.from(docFreq.entries())
    .filter(([_, df]) => df >= 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTerms)

  const idfMap = {}
  for (const [term, df] of sorted) {
    // idf(term) = ln((N + 1) / (df + 1)) + 1
    idfMap[term] = Math.log((N + 1) / (df + 1)) + 1
  }

  return {
    version: 'vocab-v1',
    idfMap,
    terms: Object.keys(idfMap)
  }
}

export function extractRepositoryFeatures(repository, vocabulary, featureSpace = null) {
  if (!repository || typeof repository !== 'object') {
    return {
      repoId: null,
      canonicalKey: null,
      owner: null,
      name: null,
      fullName: null,
      primaryLanguage: null,
      topics: [],
      vector: {},
      sparseVector: null,
      vocabularyVersion: vocabulary?.version || 'vocab-v1',
      starCount: null,
      forkCount: null,
      updatedAt: null
    }
  }

  const effectiveFeatureSpace = featureSpace || (vocabulary?.kind === 'feature_space' ? vocabulary : null)
  const idfMap = vocabulary?.idfMap || {}

  // 1. 词项权重统计: desc/topic 记 2，name 记 2，README 记 1
  const termCounts = new Map()

  function addTerms(str, weight) {
    if (!str) return
    const tokens = tokenizeText(str)
    for (const t of tokens) {
      termCounts.set(t, (termCounts.get(t) || 0) + weight)
    }
  }

  addTerms(repository.name, 2)
  addTerms(repository.description, 2)
  addTerms((repository.topics || []).join(' '), 2)
  addTerms((repository.readmeText || '').slice(0, 8000), 1)

  // 2. TF-IDF 计算与 L2 归一化
  const vector = {}
  let normSq = 0

  for (const [term, count] of termCounts.entries()) {
    if (idfMap[term]) {
      // tf = 1 + ln(count)
      const tf = 1 + Math.log(count)
      const tfidf = tf * idfMap[term]
      vector[term] = tfidf
      normSq += tfidf * tfidf
    }
  }

  const norm = Math.sqrt(normSq)
  if (norm > 0) {
    for (const k of Object.keys(vector)) {
      vector[k] /= norm
    }
  }

  const fullName = repository.fullName || (repository.owner && repository.name ? `${repository.owner}/${repository.name}` : null)
  const owner = repository.owner || (fullName && fullName.includes('/') ? fullName.split('/')[0] : null)
  const name = repository.name || (fullName && fullName.includes('/') ? fullName.split('/')[1] : null)
  const canonicalKey = repository.canonicalKey || (fullName ? fullName.toLowerCase() : null)
  const topics = Array.isArray(repository.topics) ? [...repository.topics] : []
  const description = repository.description ?? null
  const readmeText = repository.readmeText ?? null
  const cues = extractRepositoryEvidenceCues({ ...repository, description, readmeText, topics })

  let sparseVector = repository.sparseVector || (repository.vector?.indices ? repository.vector : null)
  let projectionMeta = repository.projectionMeta || null
  if (effectiveFeatureSpace) {
    const projected = projectRepositoryToFeatureSpace(
      { ...repository, primaryLanguage: repository.primaryLanguage || null, topics, description, readmeText, name },
      effectiveFeatureSpace
    )
    if (projected) {
      sparseVector = projected.sparseVector
      projectionMeta = {
        featureSpaceVersion: projected.featureSpaceVersion,
        modelVersion: projected.modelVersion,
        knownLanguage: projected.knownLanguage,
        knownTopics: projected.knownTopics,
        knownTermCount: projected.knownTermCount,
        missingFeatures: projected.missingFeatures
      }
    }
  }

  return {
    ...repository,
    repoId: repository.repoId !== undefined && repository.repoId !== null ? String(repository.repoId) : null,
    canonicalKey,
    owner,
    name,
    fullName,
    htmlUrl: repository.htmlUrl || (fullName ? `https://github.com/${fullName}` : null),
    description,
    readmeText,
    primaryLanguage: repository.primaryLanguage || null,
    topics,
    vector: Object.keys(vector).length > 0 ? vector : (repository.vector && !repository.vector.indices ? repository.vector : {}),
    sparseVector,
    projectionMeta,
    vocabularyVersion: vocabulary?.version || 'vocab-v1',
    starCount: repository.starCount ?? null,
    forkCount: repository.forkCount ?? null,
    updatedAt: repository.updatedAt ?? null,
    pushedAt: repository.pushedAt ?? repository.updatedAt ?? null,
    purposeCue: repository.purposeCue ?? cues.purposeCue,
    purposeSource: repository.purposeSource ?? cues.purposeSource,
    installCue: repository.installCue ?? cues.installCue,
    installSource: repository.installSource ?? cues.installSource,
    attentionSignal: repository.attentionSignal || {
      count: repository.starCount ?? null,
      precision: repository.countPrecision?.starCount || 'exact',
      label: '关注度'
    }
  }
}

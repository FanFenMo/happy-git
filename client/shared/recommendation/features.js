/**
 * shared/recommendation/features.js
 * 项目特征抽取、技术分词、词表拟合与向量构建 (依据 project.md 第九节)
 */

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

export function extractRepositoryFeatures(repository, vocabulary) {
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
      vocabularyVersion: vocabulary?.version || 'vocab-v1',
      starCount: null,
      forkCount: null,
      updatedAt: null
    }
  }

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

  return {
    ...repository,
    repoId: repository.repoId !== undefined && repository.repoId !== null ? String(repository.repoId) : null,
    canonicalKey,
    owner,
    name,
    fullName,
    htmlUrl: repository.htmlUrl || (fullName ? `https://github.com/${fullName}` : null),
    description: repository.description ?? null,
    readmeText: repository.readmeText ?? null,
    primaryLanguage: repository.primaryLanguage || null,
    topics: Array.isArray(repository.topics) ? [...repository.topics] : [],
    vector,
    vocabularyVersion: vocabulary?.version || 'vocab-v1',
    starCount: repository.starCount ?? null,
    forkCount: repository.forkCount ?? null,
    updatedAt: repository.updatedAt ?? null
  }
}

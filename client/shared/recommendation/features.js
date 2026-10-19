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

  // 2. 匹配英文字词、数字及连字符词
  const words = processed.match(/[a-z0-9_\u4e00-\u9fa5]{2,30}/g) || []
  for (const w of words) {
    if (w.length >= 2) {
      tokens.push(w)
    }
  }

  return tokens
}

export function buildVocabulary(repositories, maxTerms = 5000) {
  const docFreq = new Map()
  const N = repositories.length

  for (const repo of repositories) {
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

  // 按词频降序排序，选取前 maxTerms 个
  const sorted = Array.from(docFreq.entries())
    .filter(([_, df]) => df >= 1)
    .sort((a, b) => b[1] - a[1])
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

  return {
    canonicalKey: repository.canonicalKey,
    primaryLanguage: repository.primaryLanguage || null,
    topics: repository.topics || [],
    vector,
    starCount: repository.starCount,
    forkCount: repository.forkCount,
    updatedAt: repository.updatedAt
  }
}

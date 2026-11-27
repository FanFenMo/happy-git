import { PRESERVED_TECH_TERMS, tokenizeText } from './features.js'

const labels = new Map(Object.entries({
  typescript: 'TypeScript', javascript: 'JavaScript', vue: 'Vue', 'vue.js': 'Vue.js',
  'c++': 'C++', 'c#': 'C#', '.net': '.NET', llm: 'LLM', rag: 'RAG', k8s: 'K8s',
  hadoop: 'Hadoop', sqlite: 'SQLite', python: 'Python', golang: 'Go', react: 'React',
  'node.js': 'Node.js', nodejs: 'Node.js', pytorch: 'PyTorch', tensorflow: 'TensorFlow',
  docker: 'Docker', kubernetes: 'Kubernetes', wasm: 'WASM', api: 'API',
  '3dgs': '3DGS', graphql: 'GraphQL', mysql: 'MySQL', postgresql: 'PostgreSQL'
}))

const noise = new Set(`
  the and for with from that this using used based build built simple fast easy lightweight modern open
  source project library tool tools framework github http https www com org io readme license mit apache repo
  install example examples demo documentation docs code repository repositories 未标注
`.trim().split(/\s+/))

const technicalTerms = new Set([...PRESERVED_TECH_TERMS, ...labels.keys()])

export function canonicalKeyword(term) {
  return String(term ?? '').normalize('NFKC').trim().toLowerCase()
}

export function buildReverseFeatureSpace(featureSpace) {
  const reverse = new Map()
  for (const source of ['language', 'topic', 'text']) {
    for (const [term, value] of Object.entries(featureSpace[source] || {})) {
      const index = source === 'text' ? value.index : value
      if (Number.isInteger(index) && index >= 0) reverse.set(index, { term, source })
    }
  }
  return reverse
}

function textCounts(repository) {
  const counts = new Map()
  const description = repository.description || ''
  const cues = repository.purposeCue === description ? '' : repository.purposeCue || ''
  for (const [text, weight] of [[repository.name, 2], [description, 2], [cues, 1]]) {
    for (const token of tokenizeText((text || '').slice(0, 1500))) {
      counts.set(token, (counts.get(token) || 0) + weight)
    }
  }
  return counts
}

function fallbackVector(repository, corpus) {
  const counts = textCounts(repository)
  const frequency = new Map([...counts.keys()].map(term => [term, 0]))
  for (const other of corpus) {
    for (const term of textCounts(other).keys()) {
      if (frequency.has(term)) frequency.set(term, frequency.get(term) + 1)
    }
  }
  const weighted = [...counts].map(([term, count]) => [
    term, (1 + Math.log(count)) * (1 + Math.log((corpus.length + 1) / (frequency.get(term) + 1)))
  ])
  const norm = Math.hypot(...weighted.map(([, weight]) => weight))
  return weighted.map(([term, weight]) => [term, weight / norm])
}

export function extractProjectKeywordWeights(repository, { reverseSpace, corpusRepos = [repository] } = {}) {
  const terms = new Map()
  const owner = canonicalKeyword(repository.owner || repository.fullName?.split('/')[0])

  function add(term, rawWeight, source) {
    const key = canonicalKeyword(term)
    if (key.length < 2 || !/\p{L}/u.test(key) || noise.has(key) || key === owner ||
        !Number.isFinite(rawWeight) || rawWeight <= 0) return
    const existing = terms.get(key)
    const label = labels.get(key) || (source === 'text' ? key : term.trim())
    terms.set(key, {
      term: label,
      rawWeight: (existing?.rawWeight || 0) + rawWeight,
      source: existing && existing.source !== source ? 'mixed' : source
    })
  }

  const addStructure = (language, topics, languageWeight, topicWeight) => {
    if (language) add(language, languageWeight, 'language')
    const seen = new Set()
    for (const topic of topics || []) {
      const key = canonicalKeyword(topic)
      if (seen.has(key)) continue
      seen.add(key)
      add(topic, topicWeight, 'topic')
    }
  }

  let sourceMode = 'feature_space'
  if (reverseSpace) {
    const { indices = [], values = [] } = repository.sparseVector || {}
    for (const [position, index] of indices.entries()) {
      const feature = reverseSpace.get(index)
      if (feature) add(feature.term, values[position], feature.source)
    }
    if (terms.size) {
      const average = [...terms.values()].reduce((sum, item) => sum + item.rawWeight, 0) / terms.size
      const missing = repository.projectionMeta?.missingFeatures
      addStructure(missing?.unknownLanguage, missing?.unknownTopics, 0.65 * average, 0.5 * average)
    }
  }

  if (!terms.size) {
    const localVector = Object.entries(repository.vector || {})
      .filter(([, weight]) => Number.isFinite(weight) && weight > 0)
    sourceMode = localVector.length ? 'local_tfidf' : 'on_demand_fallback'
    for (const [term, weight] of localVector.length ? localVector : fallbackVector(repository, corpusRepos)) {
      add(term, weight, 'text')
    }
    addStructure(repository.primaryLanguage, repository.topics, 0.38, 0.32)
    for (const item of terms.values()) {
      if (technicalTerms.has(canonicalKeyword(item.term))) item.rawWeight *= 1.15
    }
  }

  const sorted = [...terms.values()]
    .sort((a, b) => b.rawWeight - a.rawWeight || a.term.localeCompare(b.term, 'en'))
  return {
    sourceMode,
    totalTermsConsidered: sorted.length,
    items: sorted.slice(0, 14).map(({ term, rawWeight, source }) => [term, rawWeight, source])
  }
}

export function profileKeywordKeys(profile, manualTags = []) {
  const terms = [
    ...manualTags,
    ...(profile?.manualTags || []),
    ...Object.keys(profile?.languages || {}),
    ...Object.keys(profile?.topics || {}),
    ...(profile?.topInterests || []).map(item => item.tag),
    ...(profile?.directions || []).flatMap(direction => [
      direction.label,
      ...Object.keys(direction.languages || {}),
      ...Object.keys(direction.topics || {})
    ]),
    ...Object.entries(profile?.vector || {})
      .filter(([, weight]) => Number.isFinite(weight) && weight > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([term]) => term)
  ]
  return new Set(terms.map(canonicalKeyword).filter(Boolean))
}

export function describeProjectKeywords(payload, limit = 14, matchedTerms = new Set()) {
  const displayed = payload.items.slice(0, limit)
  const total = displayed.reduce((sum, [, rawWeight]) => sum + rawWeight, 0)
  const maximum = displayed[0]?.[1]
  return {
    sourceMode: payload.sourceMode,
    totalTermsConsidered: payload.totalTermsConsidered,
    insufficientText: displayed.length < 2,
    items: displayed.map(([term, rawWeight, source]) => {
      const canonical = canonicalKeyword(term)
      return {
        term, canonical, rawWeight, source,
        weight: rawWeight / maximum,
        sharePercent: 100 * rawWeight / total,
        matchedProfile: matchedTerms.has(canonical)
      }
    })
  }
}

export function extractProjectKeywords(repository, options = {}) {
  const weights = extractProjectKeywordWeights(repository, options)
  const matched = profileKeywordKeys(options.userProfile, options.manualTags)
  return describeProjectKeywords(weights, options.limit, matched)
}

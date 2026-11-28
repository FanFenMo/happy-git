import { extractProjectKeywordWeights } from '../../shared/recommendation/keywords.js'

const BRANCH_COLORS = {
  directions: '#315ee7',
  languages: '#187e71',
  keywords: '#785bb8',
  evidence: '#a56538'
}

const DIRECTION_FALLBACK_LABELS = {
  'direction-01': '云原生与 Web 全栈工程',
  'direction-02': 'AI 模型与分布式智能',
  'direction-03': '系统平台与跨端开发',
  'direction-04': '算法计算与前沿实验'
}

function cleanText(val) {
  return typeof val === 'string' ? val.trim() : ''
}

function normalizeDistribution(obj, limit = 6) {
  if (!obj || typeof obj !== 'object') return []
  return Object.entries(obj)
    .filter(([, v]) => Number.isFinite(Number(v)) && Number(v) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0]), 'en'))
    .slice(0, limit)
    .map(([name, val]) => ({ name, value: Number(val) }))
}

function buildInlineEvidence({ repos = [], stars = [], history = [], manualTags = [] }) {
  const map = new Map()
  const addRepo = (raw, weight, sourceLabel) => {
    if (!raw || typeof raw !== 'object') return
    const key = cleanText(raw.canonicalKey || raw.fullName || raw.name || raw.repoId).toLowerCase()
    if (!key) return
    const prev = map.get(key)
    if (!prev) {
      map.set(key, {
        repo: raw,
        fullName: cleanText(raw.fullName || raw.name || key),
        htmlUrl: cleanText(raw.htmlUrl),
        primaryLanguage: cleanText(raw.primaryLanguage),
        topics: Array.isArray(raw.topics) ? raw.topics : [],
        starCount: typeof raw.starCount === 'number' ? raw.starCount : null,
        weight,
        sources: [sourceLabel]
      })
    } else {
      prev.weight += weight
      if (!prev.sources.includes(sourceLabel)) prev.sources.push(sourceLabel)
    }
  }

  for (const r of stars || []) addRepo(r, 3.0, 'star')
  for (const r of repos || []) addRepo(r, 1.5, 'owned')
  for (const h of history || []) {
    const repo = h?.repository || h
    const visits = Math.max(1, Number(h?.visitCount || 1))
    addRepo(repo, Math.min(1 + Math.log(visits), 3), 'browse')
  }

  const languageScores = new Map()
  const keywordScores = new Map()
  for (const entry of map.values()) {
    if (entry.primaryLanguage && entry.primaryLanguage !== '未标注') {
      languageScores.set(entry.primaryLanguage, (languageScores.get(entry.primaryLanguage) || 0) + entry.weight)
    }
    const kw = extractProjectKeywordWeights(entry.repo, { corpusRepos: Array.from(map.values()).map(v => v.repo) })
    for (const [term, w, src] of kw.items || []) {
      const k = term.toLowerCase()
      const prev = keywordScores.get(k)
      const contrib = w * Math.max(0.5, entry.weight)
      if (!prev) {
        keywordScores.set(k, { term, weight: contrib, source: src, repos: [entry.fullName] })
      } else {
        prev.weight += contrib
        if (!prev.repos.includes(entry.fullName) && prev.repos.length < 4) prev.repos.push(entry.fullName)
      }
    }
  }

  for (const tag of manualTags || []) {
    const clean = cleanText(tag)
    if (!clean) continue
    const k = clean.toLowerCase()
    const prev = keywordScores.get(k)
    if (!prev) {
      keywordScores.set(k, { term: clean, weight: 4.0, source: 'manual', repos: [] })
    } else {
      prev.weight += 4.0
    }
  }

  const totalLang = Array.from(languageScores.values()).reduce((s, v) => s + v, 0)
  const languages = {}
  if (totalLang > 0) {
    for (const [k, v] of languageScores.entries()) languages[k] = v / totalLang
  }

  const sortedKeywords = Array.from(keywordScores.values()).sort((a, b) => b.weight - a.weight)
  const topInterests = sortedKeywords.slice(0, 8).map(item => ({
    tag: item.term,
    score: sortedKeywords[0]?.weight ? item.weight / sortedKeywords[0].weight : 1,
    evidenceRepos: item.repos
  }))
  const evidenceRepos = Array.from(map.values())
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12)
    .map(ev => ({
      fullName: ev.fullName,
      htmlUrl: ev.htmlUrl,
      primaryLanguage: ev.primaryLanguage,
      starCount: ev.starCount,
      weight: ev.weight,
      sources: ev.sources
    }))

  return {
    languages,
    topics: {},
    manualTags: manualTags || [],
    topInterests,
    keywords: sortedKeywords.slice(0, 12).map(k => [k.term, k.weight, k.source]),
    evidenceRepos
  }
}

function formatSourceNames(sources = []) {
  const map = { star: 'Star', owned: '自有项目', browse: '近期浏览', history: '近期浏览' }
  return (sources || []).map(s => map[s] || s).join(' / ') || '个人行为'
}

function collectKeywordLeaves(portrait, repos, stars, history, manualTags) {
  const merged = new Map()
  const push = (term, weight, source = 'topic', evidenceRepos = []) => {
    const label = cleanText(term)
    if (!label) return
    const key = label.toLowerCase()
    const prev = merged.get(key)
    const numeric = Number.isFinite(Number(weight)) ? Math.max(0.05, Number(weight)) : 0.2
    if (!prev) {
      merged.set(key, {
        label: key === label && label.length <= 5 ? label.toUpperCase() : label,
        rawLabel: label,
        weight: numeric,
        source,
        evidenceRepos: [...(evidenceRepos || [])]
      })
    } else {
      prev.weight = Math.max(prev.weight, numeric)
      for (const r of evidenceRepos || []) {
        if (!prev.evidenceRepos.includes(r) && prev.evidenceRepos.length < 4) prev.evidenceRepos.push(r)
      }
    }
  }

  const safeManualTags = Array.isArray(manualTags) && manualTags.length > 0
    ? manualTags
    : (Array.isArray(portrait?.manualTags) ? portrait.manualTags : [])
  for (const tag of safeManualTags) {
    push(tag, 1.35, 'manual', [])
  }
  for (const ti of (Array.isArray(portrait?.topInterests) ? portrait.topInterests : [])) {
    push(ti.tag, Number(ti.score || 0.5), 'interest', ti.evidenceRepos || [])
  }
  for (const { name, value } of normalizeDistribution(portrait?.topics, 10)) {
    push(name, value, 'topic', [])
  }
  for (const row of (Array.isArray(portrait?.keywords) ? portrait.keywords : [])) {
    if (Array.isArray(row) && row[0]) {
      push(row[0], Number(row[1] || 0.3), row[2] || 'text', [])
    }
  }

  if (merged.size < 4) {
    const inline = buildInlineEvidence({ repos, stars, history, manualTags })
    for (const row of inline.keywords || []) {
      push(row[0], Number(row[1] || 0.25) / 10, row[2] || 'text', [])
    }
  }

  const list = Array.from(merged.values()).sort((a, b) => b.weight - a.weight).slice(0, 7)
  const total = list.reduce((s, item) => s + item.weight, 0) || 1
  return list.map((item, idx) => ({
    id: `kw-${idx}-${item.rawLabel}`,
    label: `#${item.rawLabel}`,
    shortLabel: item.rawLabel,
    weight: item.weight,
    sharePercent: (item.weight / total) * 100,
    subtitle: item.source === 'manual' ? '手动兴趣标签' : item.source === 'language' ? '核心语言生态' : '高频技术特征',
    evidenceRepos: item.evidenceRepos
  }))
}

export function buildPersonalPortraitModel({
  cloudPortrait = null,
  localProfile = null,
  profile = null,
  repos = [],
  stars = [],
  history = [],
  manualTags = []
} = {}) {
  const hasCloud = Boolean(
    cloudPortrait?.portrait &&
    (cloudPortrait.status === 'ready' || cloudPortrait.status === 'stale')
  )
  const hasLocal = Boolean(localProfile?.profile)
  const fallbackInline = (!hasCloud && !hasLocal)
    ? buildInlineEvidence({ repos, stars, history, manualTags })
    : null

  const activePortrait = hasCloud
    ? cloudPortrait.portrait
    : (hasLocal ? localProfile.profile : fallbackInline)

  const sourceKind = hasCloud
    ? 'cloud'
    : ((activePortrait && ((activePortrait.evidenceRepos?.length || 0) > 0 || Object.keys(activePortrait.languages || {}).length > 0 || (manualTags?.length || 0) > 0))
        ? 'local'
        : 'empty')

  const langList = normalizeDistribution(activePortrait?.languages, 6)
  const keywordLeaves = collectKeywordLeaves(activePortrait, repos, stars, history, manualTags)

  const rawDirections = Array.isArray(activePortrait?.directions) ? activePortrait.directions : []
  let directionLeaves = rawDirections.slice(0, 4).map((dir, idx) => {
    const w = Math.max(0.05, Number(dir.weight || 0.25))
    const label = cleanText(dir.label) || DIRECTION_FALLBACK_LABELS[dir.directionId] || dir.directionId || `方向 ${idx + 1}`
    const langs = Array.isArray(dir.languages) ? dir.languages.filter(Boolean) : []
    const topics = Array.isArray(dir.topics) ? dir.topics.filter(Boolean) : []
    return {
      id: `dir-${dir.directionId || idx}`,
      label,
      weight: w,
      sharePercent: w * 100,
      subtitle: [...langs.slice(0, 2), ...topics.slice(0, 2)].join(' · ') || '模型聚类方向',
      evidenceRepos: Array.isArray(dir.evidenceRepos) ? dir.evidenceRepos : []
    }
  })

  if (directionLeaves.length === 0 && langList.length > 0) {
    directionLeaves = langList.slice(0, 3).map((lang, idx) => ({
      id: `dir-local-${idx}`,
      label: `${lang.name} 技术主线`,
      weight: lang.value,
      sharePercent: lang.value * 100,
      subtitle: keywordLeaves.slice(0, 2).map(k => k.shortLabel).join(' · ') || '基于本机仓库与 Star 归纳',
      evidenceRepos: (activePortrait?.evidenceRepos || [])
        .filter(e => cleanText(e.primaryLanguage).toLowerCase() === lang.name.toLowerCase())
        .slice(0, 3)
        .map(e => e.fullName)
    }))
  }

  const totalDirWeight = directionLeaves.reduce((s, d) => s + d.weight, 0) || 1
  directionLeaves = directionLeaves.map(d => ({
    ...d,
    sharePercent: (d.weight / totalDirWeight) * 100
  }))

  const langTotal = langList.reduce((s, l) => s + l.value, 0) || 1
  const langLeaves = langList.map((l, idx) => ({
    id: `lang-${idx}-${l.name}`,
    label: l.name,
    weight: l.value,
    sharePercent: (l.value / langTotal) * 100,
    subtitle: `生态占比 ${Math.round((l.value / langTotal) * 100)}%`,
    evidenceRepos: (activePortrait?.evidenceRepos || [])
      .filter(e => cleanText(e.primaryLanguage).toLowerCase() === l.name.toLowerCase())
      .slice(0, 3)
      .map(e => e.fullName)
  }))

  const evidenceRaw = Array.isArray(activePortrait?.evidenceRepos) && activePortrait.evidenceRepos.length > 0
    ? activePortrait.evidenceRepos
    : buildInlineEvidence({ repos, stars, history, manualTags }).evidenceRepos
  const evTotal = evidenceRaw.slice(0, 6).reduce((s, e) => s + Math.max(0.5, Number(e.weight || 1)), 0) || 1
  const evidenceLeaves = evidenceRaw.slice(0, 6).map((ev, idx) => {
    const w = Math.max(0.5, Number(ev.weight || 1))
    const name = cleanText(ev.fullName || ev.name || `Repo ${ev.repoId}`)
    return {
      id: `ev-${idx}-${name}`,
      label: name.length > 26 ? name.slice(0, 24) + '…' : name,
      fullName: name,
      weight: w,
      sharePercent: (w / evTotal) * 100,
      subtitle: `${formatSourceNames(ev.sources)}${ev.primaryLanguage ? ` · ${ev.primaryLanguage}` : ''}`,
      htmlUrl: cleanText(ev.htmlUrl) || (name.includes('/') ? `https://github.com/${name}` : ''),
      evidenceRepos: [name]
    }
  })

  const branches = [
    {
      id: 'directions',
      label: '核心技术方向',
      color: BRANCH_COLORS.directions,
      weight: directionLeaves.reduce((s, x) => s + x.weight, 0) || 1,
      children: directionLeaves
    },
    {
      id: 'languages',
      label: '编程生态分布',
      color: BRANCH_COLORS.languages,
      weight: langLeaves.reduce((s, x) => s + x.weight, 0) || 0.8,
      children: langLeaves
    },
    {
      id: 'keywords',
      label: '兴趣标签与关键词',
      color: BRANCH_COLORS.keywords,
      weight: keywordLeaves.reduce((s, x) => s + x.weight, 0) || 0.8,
      children: keywordLeaves
    },
    {
      id: 'evidence',
      label: '个人证据项目',
      color: BRANCH_COLORS.evidence,
      weight: evidenceLeaves.reduce((s, x) => s + x.weight, 0) || 0.6,
      children: evidenceLeaves
    }
  ].filter(b => b.children.length > 0)

  const branchWeightSum = branches.reduce((s, b) => s + b.weight, 0) || 1
  for (const b of branches) {
    b.sharePercent = (b.weight / branchWeightSum) * 100
  }

  // 雷达图维度 (5-7 个最强信号)
  const radarPool = []
  for (const l of langLeaves.slice(0, 3)) {
    radarPool.push({ id: l.id, label: l.label, raw: l.sharePercent, color: BRANCH_COLORS.languages, detail: l.subtitle })
  }
  for (const k of keywordLeaves.slice(0, 4)) {
    if (!radarPool.some(r => r.label.toLowerCase() === k.shortLabel.toLowerCase())) {
      radarPool.push({ id: k.id, label: k.shortLabel, raw: k.sharePercent * 1.15, color: BRANCH_COLORS.keywords, detail: k.subtitle })
    }
  }
  for (const d of directionLeaves.slice(0, 2)) {
    if (radarPool.length < 7) {
      radarPool.push({ id: d.id, label: d.label.slice(0, 10), raw: d.sharePercent, color: BRANCH_COLORS.directions, detail: d.subtitle })
    }
  }
  const maxRadar = Math.max(...radarPool.map(r => r.raw), 1)
  const radarAxes = radarPool.slice(0, 7).map((item, idx) => ({
    ...item,
    index: idx,
    score: Math.max(22, Math.min(100, Math.round((item.raw / maxRadar) * 100)))
  }))

  // 星图轨道节点
  const constellationNodes = []
  branches.forEach((branch) => {
    branch.children.slice(0, 4).forEach((child, cIdx) => {
      const tier = cIdx === 0 ? 1 : (cIdx === 1 ? 2 : 3)
      const radiusFactor = tier === 1 ? 0.38 : tier === 2 ? 0.64 : 0.88
      const baseAngle = ((constellationNodes.length * 137.5) % 360)
      constellationNodes.push({
        id: child.id,
        branchId: branch.id,
        branchLabel: branch.label,
        label: child.label,
        subtitle: child.subtitle,
        sharePercent: child.sharePercent,
        color: branch.color,
        tier,
        radiusFactor,
        baseAngle,
        size: Math.max(7, Math.min(16, 7 + Math.sqrt(Math.max(1, child.sharePercent)) * 1.15)),
        htmlUrl: child.htmlUrl || '',
        evidenceRepos: child.evidenceRepos || []
      })
    })
  })

  const displayName = cleanText(profile?.displayName || profile?.login || '开发者画像')
  const login = cleanText(profile?.login)
  const primaryFocus = directionLeaves[0]?.label || langLeaves[0]?.label || '开源探索中'

  return {
    sourceKind,
    cloudStatus: cloudPortrait?.status || 'unbound',
    modelVersion: hasCloud ? (cloudPortrait.modelVersion || 'cloud-model') : (hasLocal ? (localProfile.modelVersion || 'content-v1') : 'local-live'),
    generationId: hasCloud ? (cloudPortrait.generationId || null) : null,
    generatedAt: hasCloud ? cloudPortrait.generatedAt : (localProfile?.generatedAt || Date.now()),
    root: {
      id: 'root-user',
      label: displayName,
      handle: login ? `@${login}` : '',
      avatarUrl: cleanText(profile?.avatarUrl),
      primaryFocus,
      evidenceCount: evidenceRaw.length,
      branchCount: branches.length
    },
    branches,
    radarAxes,
    constellationNodes
  }
}

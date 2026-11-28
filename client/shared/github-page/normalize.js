/**
 * shared/github-page/normalize.js
 * 网页 DTO 严格规范化与数量/日期解析 (依据 project.md 第四节与第十一节)
 */

export function parseCount(val) {
  if (val === undefined || val === null || val === '') {
    return { count: null, precision: 'unknown' }
  }
  if (typeof val === 'number') {
    return { count: Number.isFinite(val) ? val : null, precision: 'exact' }
  }

  const str = String(val).trim().toLowerCase().replace(/,/g, '')
  if (!str) {
    return { count: null, precision: 'unknown' }
  }

  // 处理 1.2k, 3.5m 格式
  if (str.endsWith('k')) {
    const num = parseFloat(str.slice(0, -1))
    return { count: Number.isFinite(num) ? Math.round(num * 1000) : null, precision: 'approximate' }
  }
  if (str.endsWith('m')) {
    const num = parseFloat(str.slice(0, -1))
    return { count: Number.isFinite(num) ? Math.round(num * 1000000) : null, precision: 'approximate' }
  }

  const intVal = parseInt(str, 10)
  if (Number.isFinite(intVal)) {
    return { count: intVal, precision: 'exact' }
  }
  return { count: null, precision: 'unknown' }
}

export function parseTimestamp(dateVal) {
  if (!dateVal) return null
  if (typeof dateVal === 'number') return dateVal
  const t = new Date(dateVal).getTime()
  return Number.isNaN(t) ? null : t
}

const INSTALL_COMMAND_PATTERNS = [
  /\b(?:npm\s+(?:install|i)|pnpm\s+add|yarn\s+add|bun\s+add)\s+[a-z0-9@/_.-]+/i,
  /\b(?:pip|pip3|uv\s+pip)\s+install\s+[a-z0-9_.\-[\]]+/i,
  /\bcargo\s+(?:add|install)\s+[a-z0-9_-]+/i,
  /\bgo\s+(?:get|install)\s+[a-z0-9./_@-]+/i,
  /\bdocker\s+(?:run|pull|compose\s+up)\b[^\n\r]{0,80}/i,
  /\b(?:mvn\s+clean|gradle\s+build|cmake\s+-B|make\s+install)\b[^\n\r]{0,60}/i,
  /\bgit\s+clone\s+https?:\/\/[^\s\n\r]+/i
]

export function extractRepositoryEvidenceCues(raw = {}) {
  if (!raw || typeof raw !== 'object') {
    return {
      purposeCue: null,
      purposeSource: 'missing',
      installCue: null,
      installSource: 'missing'
    }
  }

  let purposeCue = raw.purposeCue || null
  let purposeSource = raw.purposeSource || 'missing'

  const desc = typeof raw.description === 'string' ? raw.description.trim() : ''
  const readme = typeof raw.readmeText === 'string' ? raw.readmeText.trim() : ''
  const topics = Array.isArray(raw.topics) ? raw.topics.map(t => String(t).trim()).filter(Boolean) : []

  if (!purposeCue) {
    if (desc) {
      const firstSentence = desc.split(/(?<=[。！？.!?])\s+/)[0].trim()
      purposeCue = (firstSentence || desc).slice(0, 140)
      purposeSource = 'description'
    } else if (readme) {
      const lines = readme
        .split(/\r?\n/)
        .map(l => l.replace(/^#+\s*/, '').trim())
        .filter(l => l.length >= 8 && !l.startsWith('![') && !l.startsWith('[!['))
      if (lines.length > 0) {
        purposeCue = lines[0].slice(0, 140)
        purposeSource = 'readme'
      }
    } else if (topics.length > 0) {
      purposeCue = `聚焦 ${topics.slice(0, 4).join(' / ')} 方向`
      purposeSource = 'topics'
    }
  }

  let installCue = raw.installCue || null
  let installSource = raw.installSource || 'missing'
  if (!installCue && readme) {
    for (const pattern of INSTALL_COMMAND_PATTERNS) {
      const match = readme.match(pattern)
      if (match && match[0]) {
        installCue = match[0].trim().slice(0, 100)
        installSource = 'readme'
        break
      }
    }
  }

  return {
    purposeCue,
    purposeSource,
    installCue,
    installSource
  }
}

export function normalizeProfile(raw, fetchedAt = Date.now()) {
  if (!raw) return null
  const rawLogin = raw.login ? String(raw.login).trim() : ''
  const login = rawLogin ? (rawLogin.split(/[\s·]+/)[0] || '').trim() : null
  if (!login) return null

  const repoCount = parseCount(raw.publicRepoCount ?? raw.public_repos)
  const followerCount = parseCount(raw.followerCount ?? raw.followers)
  const followingCount = parseCount(raw.followingCount ?? raw.following)

  return {
    accountId: raw.accountId ? String(raw.accountId) : (raw.id ? String(raw.id) : null),
    login,
    displayName: raw.displayName || raw.name || null,
    avatarUrl: raw.avatarUrl || raw.avatar_url || null,
    profileUrl: raw.profileUrl || raw.html_url || `https://github.com/${encodeURIComponent(login)}`,
    bio: raw.bio ? String(raw.bio).trim() : null,
    location: raw.location ? String(raw.location).trim() : null,
    company: raw.company ? String(raw.company).trim() : null,
    publicRepoCount: repoCount.count,
    followerCount: followerCount.count,
    followingCount: followingCount.count,
    countPrecision: {
      publicRepoCount: repoCount.precision,
      followerCount: followerCount.precision,
      followingCount: followingCount.precision
    },
    fetchedAt
  }
}

export function normalizeRepository(raw, source = 'detail', fetchedAt = Date.now()) {
  if (!raw) return null

  let fullName = raw.fullName || raw.full_name || ''
  let owner = raw.owner?.login || raw.owner || ''
  let name = raw.name || ''

  if (fullName) {
    const parts = fullName.split('/')
    if (parts.length >= 2) {
      owner = owner || parts[0]
      name = name || parts[1]
      fullName = `${parts[0]}/${parts[1]}`
    }
  } else if (owner && name) {
    fullName = `${owner}/${name}`
  }

  const canonicalKey = fullName ? fullName.toLowerCase() : ''
  if (!canonicalKey) return null

  const starCount = parseCount(raw.starCount ?? raw.stargazers_count ?? raw.stars)
  const forkCount = parseCount(raw.forkCount ?? raw.forks_count ?? raw.forks)

  // 严格许可证处理
  let licenseSpdx = null
  if (raw.licenseSpdx) {
    licenseSpdx = raw.licenseSpdx
  } else if (raw.license) {
    const key = raw.license.spdx_id || raw.license.name || raw.license
    if (key && key !== 'NOASSERTION' && key !== 'null' && typeof key === 'string') {
      licenseSpdx = key
    }
  }

  // 可见性判定
  let visibility = 'unknown'
  if (raw.visibility) {
    visibility = raw.visibility
  } else if (raw.private === true || raw.isPrivate === true) {
    visibility = 'private'
  } else if (raw.private === false || raw.isPrivate === false) {
    visibility = 'public'
  }

  const updatedAt = parseTimestamp(raw.updatedAt || raw.updated_at || raw.pushedAt || raw.pushed_at)
  const pushedAt = parseTimestamp(raw.pushedAt || raw.pushed_at || raw.updatedAt || raw.updated_at)
  const readmeText = raw.readmeText ? String(raw.readmeText).slice(0, 10000) : null
  const topics = Array.isArray(raw.topics) ? raw.topics.map(t => String(t).trim()).filter(Boolean) : []
  const description = raw.description ? String(raw.description).trim() : null
  const cues = extractRepositoryEvidenceCues({
    ...raw,
    description,
    readmeText,
    topics
  })

  return {
    repoId: raw.repoId ? String(raw.repoId) : (raw.id ? String(raw.id) : null),
    canonicalKey,
    owner: owner || canonicalKey.split('/')[0] || '',
    name: name || canonicalKey.split('/')[1] || '',
    fullName,
    htmlUrl: raw.htmlUrl || raw.html_url || `https://github.com/${fullName}`,
    description,
    primaryLanguage: raw.primaryLanguage || raw.language || null,
    topics,
    starCount: starCount.count,
    forkCount: forkCount.count,
    attentionSignal: {
      count: starCount.count,
      precision: starCount.precision,
      label: '关注度'
    },
    countPrecision: {
      starCount: starCount.precision,
      forkCount: forkCount.precision
    },
    visibility,
    isFork: typeof raw.isFork === 'boolean' ? raw.isFork : (typeof raw.fork === 'boolean' ? raw.fork : null),
    isArchived: typeof raw.isArchived === 'boolean' ? raw.isArchived : (typeof raw.archived === 'boolean' ? raw.archived : null),
    licenseSpdx,
    updatedAt,
    pushedAt,
    createdAt: parseTimestamp(raw.createdAt || raw.created_at),
    starredAt: parseTimestamp(raw.starredAt || raw.starred_at),
    readmeText,
    purposeCue: cues.purposeCue,
    purposeSource: cues.purposeSource,
    installCue: cues.installCue,
    installSource: cues.installSource,
    fetchedAt,
    source
  }
}

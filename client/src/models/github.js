/**
 * GitHub 原始对象标准化模型
 * 转换 snake_case 为 camelCase，ID 统一为字符串，时间戳统一为毫秒
 */

function parseDateToTimestamp(dateVal) {
  if (!dateVal) return null
  if (typeof dateVal === 'number') return dateVal
  const t = new Date(dateVal).getTime()
  return Number.isNaN(t) ? null : t
}

export function normalizeProfile(raw, fetchedAt = Date.now()) {
  if (!raw) return null
  const login = raw.login || ''
  return {
    accountId: String(raw.id || login),
    login,
    displayName: raw.name || login,
    avatarUrl: raw.avatar_url || null,
    profileUrl: raw.html_url || `https://github.com/${login}`,
    bio: raw.bio || null,
    location: raw.location || null,
    company: raw.company || null,
    publicRepoCount: typeof raw.public_repos === 'number' ? raw.public_repos : 0,
    followerCount: typeof raw.followers === 'number' ? raw.followers : 0,
    followingCount: typeof raw.following === 'number' ? raw.following : 0,
    fetchedAt
  }
}

export function normalizeRepository(raw, fetchedAt = Date.now(), starredAt = null) {
  if (!raw) return null
  const fullName = raw.full_name || raw.fullName || raw.name || ''
  let [owner, name] = fullName.split('/')
  if (!name) {
    name = owner || raw.name || ''
    owner = raw.owner?.login || ''
  }

  // 许可证处理
  let licenseSpdx = null
  if (raw.license) {
    const key = raw.license.spdx_id || raw.license.name || raw.license
    if (key && key !== 'NOASSERTION' && key !== 'null') {
      licenseSpdx = key
    }
  }

  return {
    repoId: String(raw.id || raw.repoId || fullName),
    owner: owner || '',
    name: name || '',
    fullName: fullName || `${owner}/${name}`,
    description: raw.description || null,
    htmlUrl: raw.html_url || raw.htmlUrl || `https://github.com/${fullName}`,
    primaryLanguage: raw.language || raw.primaryLanguage || '未标注',
    topics: Array.isArray(raw.topics) ? raw.topics : [],
    starCount: typeof raw.stargazers_count === 'number' ? raw.stargazers_count : (raw.stars || raw.starCount || 0),
    forkCount: typeof raw.forks_count === 'number' ? raw.forks_count : (raw.forks || raw.forkCount || 0),
    isFork: Boolean(raw.fork || raw.isFork),
    isArchived: Boolean(raw.archived || raw.isArchived),
    isPrivate: Boolean(raw.private || raw.isPrivate),
    licenseSpdx,
    createdAt: parseDateToTimestamp(raw.created_at || raw.createdAt),
    updatedAt: parseDateToTimestamp(raw.updated_at || raw.updatedAt),
    starredAt: parseDateToTimestamp(starredAt || raw.starred_at || raw.starredAt),
    fetchedAt
  }
}

export function normalizeStarredRepository(raw, fetchedAt = Date.now()) {
  if (!raw) return null
  const repoRaw = raw.repo || raw
  const starredAt = raw.starred_at || null
  return normalizeRepository(repoRaw, fetchedAt, starredAt)
}

export function normalizeTrendingRepository(raw, source = 'unknown', fetchedAt = Date.now()) {
  const repo = normalizeRepository(raw, fetchedAt)
  return repo
}

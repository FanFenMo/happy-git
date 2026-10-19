/**
 * shared/github-page/routes.js
 * GitHub 网页路由与分页路径校验 (依据 project.md 第六节)
 */

export const GITHUB_BASE = 'https://github.com'

export function profileUrl(login) {
  if (!login) return GITHUB_BASE
  return `${GITHUB_BASE}/${encodeURIComponent(login)}`
}

export function ownedRepositoriesUrl(login, pageSeq = 1, nextUrl = null) {
  if (nextUrl) return nextUrl
  const base = `${GITHUB_BASE}/${encodeURIComponent(login)}?tab=repositories`
  return pageSeq > 1 ? `${base}&page=${pageSeq}` : base
}

export function starredRepositoriesUrl(login, pageSeq = 1, nextUrl = null) {
  if (nextUrl) return nextUrl
  const base = `${GITHUB_BASE}/${encodeURIComponent(login)}?tab=stars`
  return pageSeq > 1 ? `${base}&page=${pageSeq}` : base
}

export function repositoryUrl(fullName) {
  if (!fullName) return GITHUB_BASE
  const parts = fullName.split('/')
  if (parts.length >= 2) {
    return `${GITHUB_BASE}/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`
  }
  return `${GITHUB_BASE}/${encodeURIComponent(fullName)}`
}

export function searchRepositoriesUrl(query, sort = 'stars', pageSeq = 1) {
  const params = new URLSearchParams()
  params.set('q', query || '')
  params.set('type', 'repositories')
  if (sort) params.set('s', sort)
  if (sort) params.set('o', 'desc')
  if (pageSeq > 1) params.set('p', String(pageSeq))
  return `${GITHUB_BASE}/search?${params.toString()}`
}

export function trendingUrl(since = 'daily', language = '') {
  let url = `${GITHUB_BASE}/trending`
  if (language) url += `/${encodeURIComponent(language)}`
  url += `?since=${encodeURIComponent(since)}`
  return url
}

export function validateNextUrl(currentTask, nextUrl) {
  if (!nextUrl || typeof nextUrl !== 'string') return null

  try {
    const parsed = new URL(nextUrl, GITHUB_BASE)
    // 必须为 https://github.com，默认端口，不含用户名密码
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
      return null
    }
    if (parsed.port && parsed.port !== '443') {
      return null
    }
    if (parsed.username || parsed.password) {
      return null
    }

    // 校验属于当前任务的路由路径
    const expectedLogin = currentTask?.expectedLogin ? encodeURIComponent(currentTask.expectedLogin).toLowerCase() : ''
    const pathname = parsed.pathname.toLowerCase()

    if (currentTask?.pageKind === 'repositories') {
      if (expectedLogin && !pathname.includes(`/${expectedLogin}`)) {
        return null
      }
    } else if (currentTask?.pageKind === 'stars') {
      if (expectedLogin && !pathname.includes(`/${expectedLogin}`)) {
        return null
      }
    } else if (currentTask?.pageKind === 'search') {
      if (!pathname.startsWith('/search')) {
        return null
      }
    }

    return parsed.toString()
  } catch {
    return null
  }
}

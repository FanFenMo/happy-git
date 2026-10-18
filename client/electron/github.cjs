/**
 * github.cjs
 * 运行在 Electron 主进程中，负责受控 GitHub REST API 调用
 */

const API_BASE = 'https://api.github.com'
const API_VERSION = '2026-03-10'

async function requestGitHub(resource, args = {}, accessToken = null) {
  let url = ''
  let method = 'GET'
  let accept = 'application/vnd.github+json'
  let body = undefined

  switch (resource) {
    case 'currentUser':
      url = `${API_BASE}/user`
      break
    case 'ownedRepos': {
      const login = (args.login || '').trim()
      const page = args.page || 1
      if (login) {
        url = `${API_BASE}/users/${encodeURIComponent(login)}/repos?type=owner&sort=updated&direction=desc&per_page=100&page=${page}`
      } else {
        url = `${API_BASE}/user/repos?type=owner&sort=updated&direction=desc&per_page=100&page=${page}`
      }
      break
    }
    case 'starredRepos': {
      const page = args.page || 1
      url = `${API_BASE}/user/starred?sort=created&direction=desc&per_page=100&page=${page}`
      accept = 'application/vnd.github.star+json'
      break
    }
    case 'starState': {
      const owner = encodeURIComponent(args.owner || '')
      const repo = encodeURIComponent(args.repo || '')
      url = `${API_BASE}/user/starred/${owner}/${repo}`
      break
    }
    case 'addStar': {
      const owner = encodeURIComponent(args.owner || '')
      const repo = encodeURIComponent(args.repo || '')
      url = `${API_BASE}/user/starred/${owner}/${repo}`
      method = 'PUT'
      break
    }
    case 'removeStar': {
      const owner = encodeURIComponent(args.owner || '')
      const repo = encodeURIComponent(args.repo || '')
      url = `${API_BASE}/user/starred/${owner}/${repo}`
      method = 'DELETE'
      break
    }
    case 'searchTrending': {
      const query = encodeURIComponent(args.query || 'is:public stars:>100')
      url = `${API_BASE}/search/repositories?q=${query}&sort=stars&order=desc&per_page=20`
      break
    }
    default:
      throw new Error(`UNKNOWN_GITHUB_RESOURCE: ${resource}`)
  }

  const headers = {
    Accept: accept,
    'User-Agent': 'HappyGit-App/1.0',
    'X-GitHub-Api-Version': API_VERSION
  }

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal
    })

    const status = response.status
    const respHeaders = {
      link: response.headers.get('link') || '',
      retryAfter: response.headers.get('retry-after') || '',
      rateLimitRemaining: response.headers.get('x-ratelimit-remaining') || '',
      rateLimitReset: response.headers.get('x-ratelimit-reset') || ''
    }

    if (status === 204) {
      return { status, body: null, headers: respHeaders }
    }

    let respBody = null
    try {
      respBody = await response.json()
    } catch {
      respBody = null
    }

    return { status, body: respBody, headers: respHeaders }
  } finally {
    clearTimeout(timeoutId)
  }
}

module.exports = {
  requestGitHub
}

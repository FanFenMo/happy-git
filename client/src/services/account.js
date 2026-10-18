/**
 * 账号资料、仓库、Star 同步与兴趣计算服务
 */
import { nativeBridge } from '../platform'
import { normalizeProfile, normalizeRepository, normalizeStarredRepository } from '../models/github'

// 记录进行中的集合同步任务，支持取消
const activeSyncControllers = {
  repos: null,
  stars: null
}

// 缓存进行中的 starState 查询，避免重复并发请求
const inflightStarQueries = new Map()
const memoryStarCache = new Map()
const starVersions = new Map()

/**
 * 解析 GitHub 分页响应头中的下一页页码
 * 格式示例: <https://api.github.com/user/starred?page=2&per_page=100>; rel="next"
 */
export function extractNextPage(linkHeader, expectedResource) {
  if (!linkHeader || typeof linkHeader !== 'string') return null
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
  if (!match || !match[1]) return null

  try {
    const nextUrl = new URL(match[1])
    const validPath = expectedResource === 'starredRepos' ? nextUrl.pathname === '/user/starred' : (nextUrl.pathname === '/user/repos' || /^\/users\/[^/]+\/repos$/.test(nextUrl.pathname))
    if (nextUrl.hostname !== 'api.github.com' || nextUrl.protocol !== 'https:' || nextUrl.port || nextUrl.username || nextUrl.password || !validPath) {
      return null
    }
    const pageParam = nextUrl.searchParams.get('page')
    if (pageParam) {
      const pageNum = Number(pageParam)
      return Number.isSafeInteger(pageNum) && pageNum > 0 ? pageNum : null
    }
  } catch {
    return null
  }
  return null
}

/**
 * 同步当前账号的公开资料
 */
export async function syncProfile() {
  const invoke = nativeBridge.capture()
  const ghRes = await invoke('github.request', {
    resource: 'currentUser',
    args: {}
  })

  if (!ghRes.ok || !ghRes.data) {
    throw new Error(ghRes.error?.message || '获取个人资料失败')
  }

  const { status, body, headers } = ghRes.data

  if (status === 401) {
    const err = new Error('登录凭据已过期，请重新登录')
    err.code = 'UNAUTHORIZED'
    throw err
  }

  if (status === 403 || status === 429) {
    const retryAfter = headers?.retryAfter || headers?.rateLimitReset
    const err = new Error(retryAfter ? `GitHub API 请求频次受限，请稍后重试` : 'GitHub 请求受限')
    err.code = 'RATE_LIMITED'
    err.retryAfter = retryAfter
    throw err
  }

  if (status !== 200 || !body) {
    throw new Error(`获取资料失败 (HTTP ${status})`)
  }

  const profile = normalizeProfile(body)
  const saved = await invoke('account.saveProfile', { profile })
  if (!saved.ok) throw new Error(saved.error?.message || '资料保存失败')
  return profile
}

/**
 * 同步指定类型的仓库集合 ('repos' | 'stars')
 */
export function syncRepositoryCollection(kind, options = {}) {
  if (!['repos', 'stars'].includes(kind)) return Promise.reject(new Error('非法同步类型'))
  if (activeSyncControllers[kind]) {
    const current = activeSyncControllers[kind]
    if (!current.aborted) return current.done
    const context = nativeBridge.contextId
    return current.done.catch(() => {}).then(() => context === nativeBridge.contextId ? syncRepositoryCollection(kind, options) : { aborted: true })
  }
  const invoke = nativeBridge.capture()
  const controller = { aborted: false, generationId: null, invoke }
  activeSyncControllers[kind] = controller
  controller.done = (async () => {
    let loadedCount = 0
    try {
      const begin = await invoke('sync.begin', { kind })
      if (!begin.ok) throw new Error(begin.error?.message || '初始化同步失败')
      controller.generationId = begin.data.generationId
      let page = 1
      const resource = kind === 'repos' ? 'ownedRepos' : 'starredRepos'
      while (page !== null) {
        if (controller.aborted) return { aborted: true }
        const response = await invoke('github.request', { resource, args: { page, login: options.login || '' } })
        if (controller.aborted) return { aborted: true }
        if (!response.ok) throw Object.assign(new Error(response.error?.message || '同步请求失败'), { code: response.error?.code })
        const { status, body, headers } = response.data
        if (status !== 200 || !Array.isArray(body)) throw githubError(response.data)
        const items = body.map(item => kind === 'repos' ? normalizeRepository(item) : normalizeStarredRepository(item)).filter(item => item && !item.isPrivate)
        const nextPage = extractNextPage(headers?.link, resource)
        if (nextPage !== null && nextPage <= page) throw new Error('GitHub 分页顺序异常')
        const written = await invoke('sync.writePage', { kind, generationId: controller.generationId, page, items, nextPage })
        if (!written.ok) throw new Error(written.error?.message || '同步缓存写入失败')
        loadedCount = written.data.loadedCount
        options.onProgress?.({ loadedCount, page })
        page = nextPage
      }
      if (controller.aborted) return { aborted: true }
      const finished = await invoke('sync.finish', { kind, generationId: controller.generationId })
      if (!finished.ok) throw new Error(finished.error?.message || '同步提交失败')
      controller.generationId = null
      if (kind === 'stars') memoryStarCache.clear()
      return { kind, aborted: false, loadedCount: finished.data.activeCount, complete: true, lastSyncedAt: finished.data.lastSyncedAt }
    } finally {
      if (controller.generationId) await invoke('sync.abort', { kind, generationId: controller.generationId, errorCode: controller.aborted ? 'CANCELLED' : 'SYNC_FAILED' })
      if (activeSyncControllers[kind] === controller) activeSyncControllers[kind] = null
    }
  })()
  return controller.done
}

function githubError({ status, headers = {} }) {
  const limited = status === 429 || (status === 403 && (headers.rateLimitRemaining === '0' || headers.retryAfter))
  const message = status === 401 ? 'GitHub 授权已失效，请重新登录' : limited ? 'GitHub 请求频次受限，请稍后重试' : status === 403 ? '授权缺少 Star 读写权限，请检查 GitHub 应用权限并重新授权' : `GitHub 请求失败 (HTTP ${status})`
  return Object.assign(new Error(message), { code: status === 401 ? 'AUTH_REQUIRED' : limited ? 'RATE_LIMITED' : 'GITHUB_ERROR', retryAt: limited ? (headers.retryAfter ? Date.now() + Number(headers.retryAfter) * 1000 : Number(headers.rateLimitReset) * 1000 || Date.now() + 60000) : null })
}

/**
 * 同步用户拥有的公开仓库
 */
export async function syncOwnedRepositories(options = {}) {
  return syncRepositoryCollection('repos', options)
}

/**
 * 同步用户 Star 的公开仓库
 */
export async function syncStarredRepositories(options = {}) {
  return syncRepositoryCollection('stars', options)
}

/**
 * 取消正在进行的集合同步
 */
export async function cancelCollectionSync(kind) {
  const controller = activeSyncControllers[kind]
  if (!controller) return
  controller.aborted = true
  try { await controller.done } catch { /* 任务失败由同步调用者处理。 */ }
}

export function resetAccountTasks() {
  for (const controller of Object.values(activeSyncControllers)) if (controller) controller.aborted = true
  memoryStarCache.clear()
  starVersions.clear()
  inflightStarQueries.clear()
}

export async function loadAllRepositories(kind) {
  const invoke = nativeBridge.capture()
  let offset = 0, items = []
  do {
    const res = await invoke('repositories.list', { kind, offset, limit: 100 })
    if (!res.ok) throw new Error(res.error?.message || '读取兴趣数据失败')
    items.push(...res.data.items)
    offset = res.data.nextOffset
  } while (offset !== null)
  return items
}

/**
 * 读取本地缓存中的仓库分页
 */
export async function loadRepositoryPage(kind, offset = 0, limit = 30) {
  const res = await nativeBridge.invoke('repositories.list', { kind, offset, limit })
  if (!res.ok) {
    throw new Error(res.error?.message || '读取仓库列表失败')
  }
  return res.data
}

/**
 * 刷新整个账号数据（资料、仓库、Star），容忍部分失败
 */
export async function refreshAccount(options = {}) {
  const [profileResult, reposResult, starsResult] = await Promise.allSettled([
    syncProfile(),
    syncOwnedRepositories(options),
    syncStarredRepositories(options)
  ])

  return {
    profile: profileResult.status === 'fulfilled' ? profileResult.value : null,
    profileError: profileResult.status === 'rejected' ? profileResult.reason : null,
    repos: reposResult.status === 'fulfilled' ? reposResult.value : null,
    reposError: reposResult.status === 'rejected' ? reposResult.reason : null,
    stars: starsResult.status === 'fulfilled' ? starsResult.value : null,
    starsError: starsResult.status === 'rejected' ? starsResult.reason : null
  }
}

/**
 * 获取指定仓库的 Star 状态
 * 优先检查本地完整 Star 缓存或内存缓存；若未知则请求 GitHub API
 */
export async function getStarState(repository) {
  if (!repository?.repoId) return null
  const context = nativeBridge.contextId, key = `${context}:${repository.repoId}`
  const invoke = nativeBridge.capture()
  const version = starVersions.get(key) || 0
  const currentResult = value => (starVersions.get(key) || 0) === version ? value : memoryStarCache.get(key) ?? null
  if (memoryStarCache.has(key)) return memoryStarCache.get(key)
  if (inflightStarQueries.has(key)) return inflightStarQueries.get(key)
  const query = (async () => {
    const local = await invoke('repositories.isStarred', { repoId: repository.repoId })
    if (local.ok && local.data?.known) {
      const value = currentResult(local.data.starred)
      if (context === nativeBridge.contextId && (starVersions.get(key) || 0) === version) memoryStarCache.set(key, value)
      return value
    }
    const result = await invoke('github.request', { resource: 'starState', args: repoArgs(repository) })
    if (!result.ok || ![204, 404].includes(result.data?.status)) return null
    const starred = currentResult(result.data.status === 204)
    if (context === nativeBridge.contextId && (starVersions.get(key) || 0) === version) memoryStarCache.set(key, starred)
    return starred
  })().finally(() => inflightStarQueries.delete(key))
  inflightStarQueries.set(key, query)
  return query
}

function repoArgs(repository) {
  const [owner, repo] = (repository.fullName || '').split('/')
  return { owner: repository.owner || owner, repo: repository.name || repo }
}
const starMutations = new Map()
export function setStar(repository, starred) {
  const context = nativeBridge.contextId, key = `${context}:${repository.repoId}`
  if (starMutations.has(key)) return starMutations.get(key)
  starVersions.set(key, (starVersions.get(key) || 0) + 1)
  const invoke = nativeBridge.capture()
  const task = (async () => {
    await cancelCollectionSync('stars')
    const args = repoArgs(repository)
    if (!args.owner || !args.repo) return { success: false, error: '仓库信息不完整' }
    let result = await invoke('github.request', { resource: starred ? 'addStar' : 'removeStar', args })
    let confirmed = result.ok && result.data.status === 204
    // 请求超时可能发生在 GitHub 已完成写入之后，只查询远端状态，不盲目重复写入。
    if (!result.ok && context === nativeBridge.contextId && !['SESSION_CHANGED', 'AUTH_REQUIRED'].includes(result.error?.code)) {
      const check = await invoke('github.request', { resource: 'starState', args })
      confirmed = check.ok && [204, 404].includes(check.data.status) && (check.data.status === 204) === starred
    }
    if (!confirmed) return { success: false, error: result.ok ? githubError(result.data).message : result.error?.message || 'Star 请求失败' }
    memoryStarCache.set(key, starred)
    const saved = await invoke('stars.applyConfirmed', { repository, starred })
    return { success: true, starred, cacheSaved: saved.ok, warning: saved.ok ? null : 'GitHub 已更新，本地缓存保存失败，请刷新列表' }
  })().finally(() => starMutations.delete(key))
  starMutations.set(key, task)
  return task
}

/**
 * 轻量归纳计算技术兴趣标签 (最高 8 个)
 * 规则:
 * - 本人非 Fork 仓库: 主语言记 4 分，每个 topic 记 2 分
 * - 本人 Fork 仓库与 Star 仓库: 主语言记 2 分，每个 topic 记 1 分
 * - 同一 repoId 同时出现在本人仓库与 Star 时，按本人仓库规则只计一次
 * - 用户手选标签优先，自动标签补齐，总共最多 8 个
 */
export function deriveInterestTags(owned = [], starred = [], manual = []) {
  // 1. 处理手选标签 (去空白、保留原字符，用于展示)
  const normalizedManual = []
  const manualKeySet = new Set()

  for (const tag of manual || []) {
    if (typeof tag !== 'string') continue
    const clean = tag.trim().slice(0, 24)
    if (!clean) continue
    const key = clean.toLowerCase()
    if (!manualKeySet.has(key)) {
      manualKeySet.add(key)
      normalizedManual.push(clean)
      if (normalizedManual.length >= 8) {
        return normalizedManual
      }
    }
  }

  // 2. 仓库去重与分类
  const repoMap = new Map()

  for (const repo of owned || []) {
    if (!repo || !repo.repoId) continue
    repoMap.set(repo.repoId, {
      repo,
      category: repo.isFork ? 'owned_fork' : 'owned_source'
    })
  }

  for (const repo of starred || []) {
    if (!repo || !repo.repoId) continue
    if (!repoMap.has(repo.repoId)) {
      repoMap.set(repo.repoId, {
        repo,
        category: 'starred'
      })
    }
  }

  // 3. 统计标签分值
  const scoreMap = new Map() // key -> { key, display, score }

  function addScore(displayStr, weight) {
    if (!displayStr || typeof displayStr !== 'string') return
    const clean = displayStr.trim().slice(0, 24)
    if (!clean || clean === '未标注') return
    const key = clean.toLowerCase()
    if (manualKeySet.has(key)) return // 手选已占用

    if (!scoreMap.has(key)) {
      scoreMap.set(key, { key, display: clean, score: 0 })
    }
    scoreMap.get(key).score += weight
  }

  for (const { repo, category } of repoMap.values()) {
    const langWeight = category === 'owned_source' ? 4 : 2
    const topicWeight = category === 'owned_source' ? 2 : 1

    if (repo.primaryLanguage) {
      addScore(repo.primaryLanguage, langWeight)
    }

    if (Array.isArray(repo.topics)) {
      for (const topic of repo.topics) {
        addScore(topic, topicWeight)
      }
    }
  }

  // 4. 排序: 分数降序，相同按字典升序
  const candidates = Array.from(scoreMap.values()).sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score
    }
    return a.key.localeCompare(b.key)
  })

  // 5. 组合手选与自动标签，截取至多 8 个
  const remainingSlots = 8 - normalizedManual.length
  const autoTags = candidates.slice(0, remainingSlots).map((c) => c.display)

  return [...normalizedManual, ...autoTags]
}

/**
 * 校验、切分并保存手选兴趣标签
 */
export async function saveInterestPreferences(manualInput) {
  const invoke = nativeBridge.capture()
  let rawList = []
  if (Array.isArray(manualInput)) {
    rawList = manualInput
  } else if (typeof manualInput === 'string') {
    rawList = manualInput.split(/[,，]/)
  }

  const manualTags = []
  const seen = new Set()

  for (const item of rawList) {
    if (typeof item !== 'string') continue
    const clean = item.trim().slice(0, 24)
    if (!clean) continue
    const key = clean.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      manualTags.push(clean)
      if (manualTags.length >= 8) break
    }
  }

  // 读取当前设置保留 historyEnabled
  const snapRes = await invoke('account.readSnapshot')
  if (!snapRes.ok) throw new Error(snapRes.error?.message || '读取账号偏好失败')
  const historyEnabled = Boolean(snapRes.data?.preferences?.historyEnabled)

  const res = await invoke('account.savePreferences', {
    manualTags,
    historyEnabled
  })

  if (!res.ok) {
    throw new Error(res.error?.message || '保存兴趣设置失败')
  }

  return manualTags
}

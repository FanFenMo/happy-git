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
    if (nextUrl.hostname !== 'api.github.com' || nextUrl.protocol !== 'https:') {
      return null
    }
    const pageParam = nextUrl.searchParams.get('page')
    if (pageParam) {
      const pageNum = parseInt(pageParam, 10)
      return Number.isFinite(pageNum) && pageNum > 0 ? pageNum : null
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
  const ghRes = await nativeBridge.invoke('github.request', {
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
  await nativeBridge.invoke('account.saveProfile', { profile })
  return profile
}

/**
 * 同步指定类型的仓库集合 ('repos' | 'stars')
 */
export async function syncRepositoryCollection(kind, options = {}) {
  if (kind !== 'repos' && kind !== 'stars') {
    throw new Error(`非法同步类型: ${kind}`)
  }

  // 若已有进行中的同类型同步，先中止
  if (activeSyncControllers[kind]) {
    activeSyncControllers[kind].aborted = true
  }

  const controller = { aborted: false, generationId: null }
  activeSyncControllers[kind] = controller

  try {
    const beginRes = await nativeBridge.invoke('sync.begin', { kind })
    if (!beginRes.ok || !beginRes.data?.generationId) {
      throw new Error(beginRes.error?.message || '初始化同步失败')
    }

    const generationId = beginRes.data.generationId
    controller.generationId = generationId

    let page = 1
    let loadedCount = 0
    const resource = kind === 'repos' ? 'ownedRepos' : 'starredRepos'

    while (page !== null && !controller.aborted) {
      const ghRes = await nativeBridge.invoke('github.request', {
        resource,
        args: { page, login: options.login || '' }
      })

      if (controller.aborted) {
        await nativeBridge.invoke('sync.abort', { kind, generationId, errorCode: 'ABORTED' })
        return { kind, aborted: true, loadedCount }
      }

      if (!ghRes.ok || !ghRes.data) {
        const errMessage = ghRes.error?.message || '拉取数据失败'
        await nativeBridge.invoke('sync.abort', { kind, generationId, errorCode: 'NETWORK_ERROR' })
        throw new Error(errMessage)
      }

      const { status, body, headers } = ghRes.data

      if (status === 401) {
        await nativeBridge.invoke('sync.abort', { kind, generationId, errorCode: 'UNAUTHORIZED' })
        const err = new Error('授权失效')
        err.code = 'UNAUTHORIZED'
        throw err
      }

      if (status === 403 || status === 429) {
        const retryAt = headers?.rateLimitReset ? parseInt(headers.rateLimitReset, 10) * 1000 : Date.now() + 60000
        await nativeBridge.invoke('sync.abort', { kind, generationId, errorCode: 'RATE_LIMITED', retryAt })
        const err = new Error('请求频次受限')
        err.code = 'RATE_LIMITED'
        err.retryAt = retryAt
        throw err
      }

      if (status !== 200 || !Array.isArray(body)) {
        await nativeBridge.invoke('sync.abort', { kind, generationId, errorCode: `HTTP_${status}` })
        throw new Error(`同步失败 (HTTP ${status})`)
      }

      // 过滤 private 仓库并按类型标准化
      const items = body
        .map((item) => (kind === 'repos' ? normalizeRepository(item) : normalizeStarredRepository(item)))
        .filter((item) => item && !item.isPrivate)

      const nextPage = extractNextPage(headers?.link, resource)

      const writeRes = await nativeBridge.invoke('sync.writePage', {
        kind,
        generationId,
        page,
        items,
        nextPage
      })

      if (!writeRes.ok) {
        await nativeBridge.invoke('sync.abort', { kind, generationId, errorCode: 'WRITE_ERROR' })
        throw new Error(writeRes.error?.message || '写入本地缓存失败')
      }

      loadedCount = writeRes.data?.loadedCount || loadedCount
      if (typeof options.onProgress === 'function') {
        options.onProgress({ loadedCount, page, hasNext: nextPage !== null })
      }

      page = nextPage
    }

    if (controller.aborted) {
      await nativeBridge.invoke('sync.abort', { kind, generationId, errorCode: 'ABORTED' })
      return { kind, aborted: true, loadedCount }
    }

    const finishRes = await nativeBridge.invoke('sync.finish', { kind, generationId })
    if (!finishRes.ok) {
      throw new Error(finishRes.error?.message || '提交同步结果失败')
    }

    return {
      kind,
      aborted: false,
      loadedCount: finishRes.data?.activeCount ?? loadedCount,
      complete: Boolean(finishRes.data?.complete),
      lastSyncedAt: finishRes.data?.lastSyncedAt || Date.now()
    }
  } finally {
    if (activeSyncControllers[kind] === controller) {
      activeSyncControllers[kind] = null
    }
  }
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
  if (activeSyncControllers[kind]) {
    activeSyncControllers[kind].aborted = true
    if (activeSyncControllers[kind].generationId) {
      await nativeBridge.invoke('sync.abort', {
        kind,
        generationId: activeSyncControllers[kind].generationId,
        errorCode: 'USER_CANCELLED'
      })
    }
    activeSyncControllers[kind] = null
  }
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
  if (!repository || !repository.repoId) return false

  // 1. 检查内存缓存
  if (memoryStarCache.has(repository.repoId)) {
    return memoryStarCache.get(repository.repoId)
  }

  // 2. 检查本地数据库是否已有记录
  const checkRes = await nativeBridge.invoke('repositories.isStarred', { repoId: repository.repoId })
  if (checkRes.ok && checkRes.data && checkRes.data.known) {
    memoryStarCache.set(repository.repoId, checkRes.data.starred)
    return checkRes.data.starred
  }

  // 3. 若处于进行中的查询，复用 Promise
  if (inflightStarQueries.has(repository.repoId)) {
    return inflightStarQueries.get(repository.repoId)
  }

  let owner = repository.owner
  let name = repository.name
  if (!owner || !name) {
    const parts = (repository.fullName || '').split('/')
    owner = parts[0]
    name = parts[1]
  }

  if (!owner || !name) return false

  const queryPromise = (async () => {
    try {
      const ghRes = await nativeBridge.invoke('github.request', {
        resource: 'starState',
        args: { owner, repo: name }
      })
      if (ghRes.ok && ghRes.data) {
        // 204 No Content 代表已 Star，404 Not Found 代表未 Star
        const isStarred = ghRes.data.status === 204
        memoryStarCache.set(repository.repoId, isStarred)
        return isStarred
      }
      return false
    } catch {
      return false
    } finally {
      inflightStarQueries.delete(repository.repoId)
    }
  })()

  inflightStarQueries.set(repository.repoId, queryPromise)
  return queryPromise
}

/**
 * 对指定仓库进行 Star 或取消 Star
 */
export async function setStar(repository, starred) {
  if (!repository || !repository.repoId) {
    return { success: false, error: '无效仓库信息' }
  }

  let owner = repository.owner
  let name = repository.name
  if (!owner || !name) {
    const parts = (repository.fullName || '').split('/')
    owner = parts[0]
    name = parts[1]
  }

  if (!owner || !name) {
    return { success: false, error: '缺少仓库所有者或名称' }
  }

  // 取消正在进行的 Star 列表同步，防止写操作被旧快照覆盖
  await cancelCollectionSync('stars')

  const resource = starred ? 'addStar' : 'removeStar'
  const ghRes = await nativeBridge.invoke('github.request', {
    resource,
    args: { owner, repo: name }
  })

  if (!ghRes.ok || !ghRes.data) {
    return { success: false, error: ghRes.error?.message || '网络请求失败' }
  }

  const { status } = ghRes.data
  // GitHub addStar/removeStar 成功时返回 204 No Content
  if (status !== 204) {
    if (status === 401) {
      return { success: false, error: '登录凭据已失效，请重新登录' }
    }
    if (status === 403 || status === 429) {
      return { success: false, error: 'GitHub 请求频次受限，请稍后重试' }
    }
    return { success: false, error: `操作未成功 (HTTP ${status})` }
  }

  // 更新内存缓存与本地数据库活动版本
  memoryStarCache.set(repository.repoId, starred)
  try {
    await nativeBridge.invoke('stars.applyConfirmed', {
      repository,
      starred
    })
  } catch (err) {
    console.warn('[accountService] 远程 Star 成功，但落库失败:', err)
  }

  return { success: true, starred }
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
  const snapRes = await nativeBridge.invoke('account.readSnapshot')
  const historyEnabled = snapRes.ok && snapRes.data?.preferences ? snapRes.data.preferences.historyEnabled : true

  const res = await nativeBridge.invoke('account.savePreferences', {
    manualTags,
    historyEnabled
  })

  if (!res.ok) {
    throw new Error(res.error?.message || '保存兴趣设置失败')
  }

  return manualTags
}

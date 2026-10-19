/**
 * client/src/services/account.js
 * 账号资料、集合同步任务与 Star 操作服务 (依据 project.md 第四节与第七节)
 */

import { nativeBridge } from '../platform'
import { OPERATIONS } from '../../shared/contracts'

const memoryStarCache = new Map()
const starVersions = new Map()
const inflightStarQueries = new Map()
const starMutations = new Map()

export function resetAccountTasks() {
  memoryStarCache.clear()
  starVersions.clear()
  inflightStarQueries.clear()
  starMutations.clear()
}

export async function readAccountSnapshot() {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.ACCOUNT_READ_SNAPSHOT)
  if (!res.ok) {
    throw new Error(res.error?.message || '读取账号快照失败')
  }
  return res.data
}

export async function syncAccount(collections = ['profile', 'repos', 'stars'], force = false) {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.ACCOUNT_SYNC, { collections, force })
  if (!res.ok) {
    throw new Error(res.error?.message || '发起同步失败')
  }
  return res.data
}

export async function readTask(taskId) {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.TASKS_READ, { taskId })
  if (!res.ok) {
    throw new Error(res.error?.message || '读取任务状态失败')
  }
  return res.data
}

export async function cancelTask(taskId) {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.TASKS_CANCEL, { taskId })
  if (!res.ok) {
    throw new Error(res.error?.message || '取消任务失败')
  }
  return res.data
}

export async function listRepositories(kind = 'repos', offset = 0, limit = 30) {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.REPOSITORIES_LIST, { kind, offset, limit })
  if (!res.ok) {
    throw new Error(res.error?.message || '获取仓库列表失败')
  }
  return res.data
}

export async function loadAllRepositories(kind) {
  let offset = 0
  const all = []
  while (true) {
    const page = await listRepositories(kind, offset, 100)
    all.push(...page.items)
    if (page.nextOffset == null || page.items.length === 0) break
    offset = page.nextOffset
  }
  return all
}

function repoArgs(repository) {
  const [owner, repo] = (repository.fullName || '').split('/')
  return { owner: repository.owner || owner, repo: repository.name || repo }
}

export async function readStarState(repoId, fullName) {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.STARS_READ_STATE, { repoId, fullName })
  if (!res.ok) {
    return { state: 'unknown', observedAt: null }
  }
  return res.data
}

export async function getStarState(repository) {
  if (!repository?.repoId) return null
  const context = nativeBridge.contextId, key = `${context}:${repository.repoId}`
  const invoke = nativeBridge.capture()
  const version = starVersions.get(key) || 0
  const currentResult = value => (starVersions.get(key) || 0) === version ? value : memoryStarCache.get(key) ?? null
  if (memoryStarCache.has(key)) return memoryStarCache.get(key)
  if (inflightStarQueries.has(key)) return inflightStarQueries.get(key)
  const query = (async () => {
    // 尝试 v2 stars.readState
    const st = await invoke(OPERATIONS.STARS_READ_STATE, { repoId: repository.repoId, fullName: repository.fullName })
    if (st.ok && st.data?.state && st.data.state !== 'unknown') {
      const starred = st.data.state === 'starred'
      const value = currentResult(starred)
      if (context === nativeBridge.contextId && (starVersions.get(key) || 0) === version) memoryStarCache.set(key, value)
      return value
    }
    // 尝试本地已知状态
    const local = await invoke('repositories.isStarred', { repoId: repository.repoId })
    if (local.ok && local.data?.known) {
      const value = currentResult(local.data.starred)
      if (context === nativeBridge.contextId && (starVersions.get(key) || 0) === version) memoryStarCache.set(key, value)
      return value
    }
    // 兼容远端查询
    const result = await invoke('github.request', { resource: 'starState', args: repoArgs(repository) })
    if (!result.ok || ![204, 404].includes(result.data?.status)) return null
    const starred = currentResult(result.data.status === 204)
    if (context === nativeBridge.contextId && (starVersions.get(key) || 0) === version) memoryStarCache.set(key, starred)
    return starred
  })().finally(() => inflightStarQueries.delete(key))
  inflightStarQueries.set(key, query)
  return query
}

export function setStar(repository, desiredStarred, intentId = null) {
  const context = nativeBridge.contextId, key = `${context}:${repository.repoId}`
  if (starMutations.has(key)) return starMutations.get(key)
  starVersions.set(key, (starVersions.get(key) || 0) + 1)
  const invoke = nativeBridge.capture()
  const task = (async () => {
    const finalIntentId = intentId || `star_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const starred = Boolean(desiredStarred)

    // 优先尝试原生 stars.set
    const res = await invoke(OPERATIONS.STARS_SET, {
      repository,
      desiredStarred: starred,
      intentId: finalIntentId
    })
    if (res.ok && res.data?.state) {
      memoryStarCache.set(key, starred)
      return { success: true, starred, cacheSaved: res.data.localCacheSaved ?? true, ...res.data }
    }

    // 兼容历史直接调用 github.request 的测试桩
    const args = repoArgs(repository)
    if (!args.owner || !args.repo) return { success: false, error: '仓库信息不完整' }
    let result = await invoke('github.request', { resource: starred ? 'addStar' : 'removeStar', args })
    let confirmed = result.ok && result.data.status === 204
    if (!result.ok && context === nativeBridge.contextId && !['SESSION_CHANGED', 'AUTH_REQUIRED'].includes(result.error?.code)) {
      const check = await invoke('github.request', { resource: 'starState', args })
      confirmed = check.ok && [204, 404].includes(check.data?.status) && (check.data?.status === 204) === starred
    }
    if (!confirmed) return { success: false, error: result.error?.message || 'Star 请求失败' }
    memoryStarCache.set(key, starred)
    const saved = await invoke('stars.applyConfirmed', { repository, starred })
    return { success: true, starred, cacheSaved: Boolean(saved.ok), warning: saved.ok ? null : 'GitHub 已更新，本地缓存保存失败，请刷新列表' }
  })().finally(() => starMutations.delete(key))
  starMutations.set(key, task)
  return task
}

export async function savePreferences(preferences) {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.ACCOUNT_SAVE_PREFERENCES, preferences)
  if (!res.ok) {
    throw new Error(res.error?.message || '保存偏好设置失败')
  }
  return res.data
}

export function deriveInterestTags(owned = [], starred = [], manual = []) {
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

  const repoMap = new Map()
  for (const repo of owned || []) {
    if (!repo || !repo.repoId) continue
    repoMap.set(repo.repoId, { repo, category: repo.isFork ? 'owned_fork' : 'owned_source' })
  }
  for (const repo of starred || []) {
    if (!repo || !repo.repoId) continue
    if (!repoMap.has(repo.repoId)) {
      repoMap.set(repo.repoId, { repo, category: 'starred' })
    }
  }

  const scoreMap = new Map()
  function addScore(displayStr, weight) {
    if (!displayStr || typeof displayStr !== 'string') return
    const clean = displayStr.trim().slice(0, 24)
    if (!clean || clean === '未标注') return
    const key = clean.toLowerCase()
    if (manualKeySet.has(key)) return

    if (!scoreMap.has(key)) {
      scoreMap.set(key, { key, display: clean, score: 0 })
    }
    scoreMap.get(key).score += weight
  }

  for (const { repo, category } of repoMap.values()) {
    const langWeight = category === 'owned_source' ? 4 : 2
    const topicWeight = category === 'owned_source' ? 2 : 1
    if (repo.primaryLanguage) addScore(repo.primaryLanguage, langWeight)
    if (Array.isArray(repo.topics)) {
      for (const topic of repo.topics) addScore(topic, topicWeight)
    }
  }

  const candidates = Array.from(scoreMap.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.key.localeCompare(b.key)
  })

  const remainingSlots = 8 - normalizedManual.length
  const autoTags = candidates.slice(0, remainingSlots).map(c => c.display)
  return [...normalizedManual, ...autoTags]
}

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

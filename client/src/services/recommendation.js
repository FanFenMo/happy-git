/**
 * client/src/services/recommendation.js
 * 本地画像计算、排序重排与结果提交服务 (依据 project.md 第二节与第九节)
 */

import { nativeBridge } from '../platform'
import { OPERATIONS } from '../../shared/contracts'
import { COMPUTE_PURPOSE, createComputeRequest } from '../../shared/recommendation/protocol'

let workerInstance = null
let pendingJobs = new Map()

function getWorker() {
  if (!workerInstance) {
    workerInstance = new Worker(new URL('../workers/recommendation.worker.js', import.meta.url), { type: 'module' })
    workerInstance.onmessage = (e) => {
      const result = e.data
      if (!result || !result.jobId) return

      const pending = pendingJobs.get(result.jobId)
      if (pending) {
        pendingJobs.delete(result.jobId)
        if (result.error) {
          pending.reject(new Error(result.error))
        } else {
          pending.resolve(result)
        }
      }
    }
    workerInstance.onerror = (err) => {
      console.error('[recommendation.worker] Worker 内部错误:', err)
    }
  }
  return workerInstance
}

function runWorkerJob(purpose, inputId, inputVersions, payload, contextId = nativeBridge.contextId) {
  return new Promise((resolve, reject) => {
    const worker = getWorker()
    const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
    pendingJobs.set(jobId, { resolve, reject })

    const request = createComputeRequest({
      jobId,
      inputId,
      contextId,
      purpose,
      inputVersions,
      payload
    })
    worker.postMessage(request)
  })
}

function parseCommitResponse(commitRes) {
  const committed = Boolean(commitRes?.ok && commitRes?.data?.ok !== false)
  const error = !commitRes?.ok
    ? (commitRes?.error?.code || commitRes?.error?.message || 'COMMIT_FAILED')
    : (commitRes?.data?.ok === false ? (commitRes.data.error || commitRes.data.code || 'INPUT_CHANGED') : null)
  return { committed, error }
}

export async function createSnapshot(purpose = 'ranking', reason = 'user_refresh') {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.RECOMMENDATION_CREATE_SNAPSHOT, { purpose, reason })
  if (!res.ok) {
    throw new Error(res.error?.message || '创建推荐快照失败')
  }
  return res.data
}

export async function computeAndCommitProfile(snapshot) {
  const invoke = nativeBridge.capture()
  const workerResult = await runWorkerJob(COMPUTE_PURPOSE.PROFILE, snapshot.inputId, snapshot.inputVersions, {
    accountId: snapshot.accountId,
    starred: snapshot.starred,
    owned: snapshot.owned,
    history: snapshot.history,
    manualTags: snapshot.manualTags,
    hiddenRepoIds: snapshot.hiddenRepoIds,
    historyEnabled: snapshot.historyEnabled,
    candidates: snapshot.candidates
  })

  const commitRes = await invoke(OPERATIONS.RECOMMENDATION_COMMIT, {
    inputId: snapshot.inputId,
    inputVersions: snapshot.inputVersions,
    purpose: 'profile',
    profile: workerResult.profile
  })

  const { committed, error } = parseCommitResponse(commitRes)
  return { profile: workerResult.profile, committed, error }
}

export async function computeAndCommitRanking(snapshot, profile) {
  const invoke = nativeBridge.capture()
  const workerResult = await runWorkerJob(COMPUTE_PURPOSE.RANKING, snapshot.inputId, snapshot.inputVersions, {
    accountId: snapshot.accountId,
    profile,
    starred: snapshot.starred,
    candidates: snapshot.candidates,
    history: snapshot.history,
    manualTags: snapshot.manualTags,
    hiddenRepoIds: snapshot.hiddenRepoIds,
    historyEnabled: snapshot.historyEnabled,
    owned: snapshot.owned
  })

  const commitRes = await invoke(OPERATIONS.RECOMMENDATION_COMMIT, {
    inputId: snapshot.inputId,
    inputVersions: snapshot.inputVersions,
    purpose: 'ranking',
    batch: workerResult.batch
  })

  const { committed, error } = parseCommitResponse(commitRes)
  return { batch: workerResult.batch, committed, error }
}

export async function listRecommendation(batchId = null, offset = 0, limit = 20) {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.RECOMMENDATION_LIST, { batchId, offset, limit })
  if (!res.ok) {
    throw new Error(res.error?.message || '读取推荐结果失败')
  }
  return res.data
}

export async function recordFeedback(repoId, kind = 'hide', eventId = null) {
  const invoke = nativeBridge.capture()
  const res = await invoke(OPERATIONS.RECOMMENDATION_FEEDBACK, {
    repoId,
    kind,
    eventId: eventId || `fb_${Date.now()}`
  })
  if (!res.ok) {
    throw new Error(res.error?.message || '记录反馈失败')
  }
  return res.data
}

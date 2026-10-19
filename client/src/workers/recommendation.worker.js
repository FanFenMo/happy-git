/**
 * client/src/workers/recommendation.worker.js
 * 纯前端 Web Worker: 本地画像计算与 MMR 排序
 * (依据 project.md 第二节、第九节与共享推荐协议)
 */

import { MODEL_VERSION, COMPUTE_PURPOSE, createComputeResult } from '../../shared/recommendation/protocol.js'
import { buildInterestProfile } from '../../shared/recommendation/profile.js'
import { createRecommendationBatch } from '../../shared/recommendation/rank.js'
import { buildVocabulary, extractRepositoryFeatures } from '../../shared/recommendation/features.js'

self.onmessage = async (e) => {
  const request = e.data
  if (!request || !request.jobId) return

  const { jobId, inputId, contextId, purpose, inputVersions, now = Date.now(), seed = 42, payload = {} } = request

  try {
    if (purpose === COMPUTE_PURPOSE.PROFILE) {
      const {
        accountId,
        starred = [],
        owned = [],
        history = [],
        manualTags = [],
        hiddenRepoIds = [],
        historyEnabled = true,
        candidates = []
      } = payload

      // 提取共享词表并为仓库提取特征向量
      const allSampleRepos = [...starred, ...owned, ...candidates]
      const vocabulary = buildVocabulary(allSampleRepos)

      const enrichedStarred = starred.map(r => extractRepositoryFeatures(r, vocabulary))
      const enrichedOwned = owned.map(r => extractRepositoryFeatures(r, vocabulary))
      const enrichedHistory = history.map(h => ({
        ...h,
        repository: extractRepositoryFeatures(h.repository || h, vocabulary)
      }))

      const profile = buildInterestProfile({
        accountId,
        starred: enrichedStarred,
        owned: enrichedOwned,
        history: enrichedHistory,
        manualTags,
        hiddenRepoIds,
        historyEnabled,
        now,
        inputVersions
      })

      const result = createComputeResult({
        jobId,
        inputId,
        contextId,
        purpose,
        inputVersions,
        profile,
        batch: null,
        error: null
      })

      self.postMessage(result)
    } else if (purpose === COMPUTE_PURPOSE.RANKING) {
      const {
        accountId,
        profile,
        candidates = [],
        history = [],
        hiddenRepoIds = [],
        owned = [],
        batchId
      } = payload

      // 词表与特征拟合
      const allSampleRepos = [...candidates, ...(profile?.evidenceRepos || [])]
      const vocabulary = buildVocabulary(allSampleRepos)
      const enrichedCandidates = candidates.map(c => extractRepositoryFeatures(c, vocabulary))

      const historyMap = new Map()
      for (const h of history) {
        const key = h.repository?.canonicalKey || h.canonicalKey
        if (key) historyMap.set(key, h)
      }

      const hiddenSet = new Set(hiddenRepoIds || [])
      const ownedSet = new Set((owned || []).map(r => r.canonicalKey || `${r.owner}/${r.name}`.toLowerCase()))

      const batch = createRecommendationBatch({
        batchId: batchId || `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        accountId,
        profile,
        candidates: enrichedCandidates,
        now,
        inputVersions,
        seed,
        historyMap,
        hiddenSet,
        ownedSet
      })

      const result = createComputeResult({
        jobId,
        inputId,
        contextId,
        purpose,
        inputVersions,
        profile: null,
        batch,
        error: null
      })

      self.postMessage(result)
    } else {
      throw new Error(`Unsupported compute purpose: ${purpose}`)
    }
  } catch (err) {
    const errorResult = createComputeResult({
      jobId,
      inputId,
      contextId,
      purpose,
      inputVersions,
      profile: null,
      batch: null,
      error: err?.message || String(err)
    })
    self.postMessage(errorResult)
  }
}

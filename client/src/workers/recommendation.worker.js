/**
 * client/src/workers/recommendation.worker.js
 * 纯前端 Web Worker: 本地画像计算与 MMR 排序
 * (依据 project.md 第二节、第九节与共享推荐协议)
 */

import { COMPUTE_PURPOSE, createComputeResult } from '../../shared/recommendation/protocol.js'
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

      // 提取共享词表并为仓库提取特征向量（保留完整 Repository DTO）
      const historyRepos = history.map(h => h?.repository || h).filter(Boolean)
      const allSampleRepos = [...starred, ...owned, ...historyRepos, ...candidates]
      const vocabulary = buildVocabulary(allSampleRepos)

      const enrichedStarred = starred.map(r => extractRepositoryFeatures(r, vocabulary))
      const enrichedOwned = owned.map(r => extractRepositoryFeatures(r, vocabulary))
      const enrichedHistory = history.map(h => ({
        ...h,
        repository: extractRepositoryFeatures(h?.repository || h, vocabulary)
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
        inputVersions,
        vocabulary
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
        starred = [],
        candidates = [],
        history = [],
        manualTags = [],
        hiddenRepoIds = [],
        historyEnabled = true,
        owned = [],
        batchId
      } = payload

      // 构建同构词表：合并用户证据仓库与当前候选池
      const historyRepos = history.map(h => h?.repository || h).filter(Boolean)
      const evidenceFromProfile = Array.isArray(profile?.evidenceRepos) ? profile.evidenceRepos : []
      const allSampleRepos = [
        ...starred,
        ...owned,
        ...historyRepos,
        ...evidenceFromProfile,
        ...candidates
      ]
      const vocabulary = buildVocabulary(allSampleRepos)

      let effectiveProfile = profile
      if (starred.length > 0 || owned.length > 0 || history.length > 0 || manualTags.length > 0) {
        effectiveProfile = buildInterestProfile({
          accountId,
          starred: starred.map(r => extractRepositoryFeatures(r, vocabulary)),
          owned: owned.map(r => extractRepositoryFeatures(r, vocabulary)),
          history: history.map(h => ({
            ...h,
            repository: extractRepositoryFeatures(h?.repository || h, vocabulary)
          })),
          manualTags: manualTags.length > 0 ? manualTags : (profile?.manualTags || []),
          hiddenRepoIds,
          historyEnabled,
          now,
          inputVersions,
          vocabulary
        })
      } else if (effectiveProfile) {
        effectiveProfile = {
          ...effectiveProfile,
          vocabulary,
          vocabularyVersion: vocabulary.version
        }
      }

      const enrichedCandidates = candidates.map(c => extractRepositoryFeatures(c, vocabulary))

      const historyMap = new Map()
      for (const h of history) {
        const repoObj = h?.repository || h
        const key = repoObj?.canonicalKey || (repoObj?.fullName ? repoObj.fullName.toLowerCase() : null)
        if (key) historyMap.set(key, h)
        if (repoObj?.repoId) historyMap.set(String(repoObj.repoId), h)
      }

      const hiddenSet = new Set((hiddenRepoIds || []).map(id => String(id)))
      const ownedSet = new Set()
      for (const r of (owned || [])) {
        if (!r) continue
        if (r.repoId !== undefined && r.repoId !== null) ownedSet.add(String(r.repoId))
        const key = r.canonicalKey || (r.fullName ? r.fullName.toLowerCase() : (r.owner && r.name ? `${r.owner}/${r.name}`.toLowerCase() : null))
        if (key) ownedSet.add(key)
      }

      const batch = createRecommendationBatch({
        batchId: batchId || `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        accountId,
        profile: effectiveProfile,
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
      error: err.message || 'Worker computation error'
    })
    self.postMessage(errorResult)
  }
}

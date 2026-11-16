/**
 * client/src/workers/recommendation.worker.js
 * 纯前端 Web Worker: 本地基线画像计算、云端画像投影与本机未处理事件增量 MMR 排序
 * (依据 project.md 第二节、第九节与第二轮本地排序接续规范)
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
        cloudPortrait = null,
        featureSpace = null,
        unprocessedEvents = [],
        processedThrough = 0,
        starred = [],
        candidates = [],
        history = [],
        manualTags = [],
        hiddenRepoIds = [],
        historyEnabled = true,
        owned = [],
        batchId
      } = payload

      const effectiveCloudPortrait = cloudPortrait || (profile?.generationId ? profile : null)
      const effectiveFeatureSpace = featureSpace || effectiveCloudPortrait?.featureSpace || null

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

      let effectiveProfile = effectiveCloudPortrait || profile
      let enrichedCandidates = candidates

      // 仅当不存在云端画像/特征空间时，才使用本地词表拟合基线画像；
      // 云端画像模式下严禁自行重拟合与服务端不兼容的词表。
      if (!effectiveCloudPortrait && !effectiveFeatureSpace) {
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
        enrichedCandidates = candidates.map(c => extractRepositoryFeatures(c, vocabulary))
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
        ownedSet,
        featureSpace: effectiveFeatureSpace,
        unprocessedEvents,
        processedThrough: Number(processedThrough ?? effectiveCloudPortrait?.processedThrough ?? 0)
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

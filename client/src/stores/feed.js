/**
 * client/src/stores/feed.js
 * 推荐与热门双页签发现流状态管理 (依据 project.md、接口与模型契约及第二轮画像搜索与排序规范)
 */

import { defineStore } from 'pinia'
import { loadTrending } from '../services/projects'
import {
  createSnapshot,
  computeAndCommitProfile,
  computeAndCommitRanking,
  listRecommendation,
  recordFeedback,
  listHiddenRecommendations
} from '../services/recommendation'
import { planDiscoveryQueries } from '../../shared/recommendation/recall'
import { refreshPersonalizedCandidates } from '../services/discovery'
import { useUserStore } from './user'

export const useFeedStore = defineStore('feed', {
  state: () => ({
    activeTab: 'recommended', // 'recommended' | 'trending'
    trendingItems: [],
    trendingLoading: false,
    trendingFetchedAt: null,

    recItems: [],
    recBatchId: null,
    recLoading: false,
    recOffset: 0,
    recTotal: 0,
    recHasMore: false,
    recProfile: null,
    recError: null,

    // 第二轮状态：真实区分云端画像 vs 本机近期增量 vs 本地基线，与有界搜索边界
    rankingSource: 'local_baseline', // 'cloud_portrait' | 'local_baseline' | 'recent_only'
    portraitStatus: 'unbound',
    modelVersion: null,
    generationId: null,
    processedThrough: 0,
    unprocessedEventCount: 0,
    searchRound: 0,
    searchPageCursors: {},
    recentQueryStrings: [],
    searchSummary: null,
    refreshSeq: 0,
    hiddenItems: [],
    hiddenLoading: false
  }),

  getters: {
    isRecommendedTab: (state) => state.activeTab === 'recommended',
    isTrendingTab: (state) => state.activeTab === 'trending',
    hasRecommendations: (state) => state.recItems.length > 0
  },

  actions: {
    setTab(tab) {
      this.activeTab = tab
    },

    resetRecommendationState() {
      this.refreshSeq += 1
      this.recItems = []
      this.recBatchId = null
      this.recOffset = 0
      this.recTotal = 0
      this.recHasMore = false
      this.recProfile = null
      this.recError = null
      this.rankingSource = 'local_baseline'
      this.portraitStatus = 'unbound'
      this.modelVersion = null
      this.generationId = null
      this.processedThrough = 0
      this.unprocessedEventCount = 0
      this.searchRound = 0
      this.hiddenItems = []
      this.searchPageCursors = {}
      this.recentQueryStrings = []
      this.searchSummary = null
    },

    async loadTrendingFeed({ force = false } = {}) {
      if (this.trendingLoading) return
      this.trendingLoading = true
      try {
        const res = await loadTrending({ force })
        this.trendingItems = res.items || []
        this.trendingFetchedAt = res.fetchedAt
      } catch (err) {
        console.warn('[FeedStore] 加载热门列表异常:', err.message)
      } finally {
        this.trendingLoading = false
      }
    },

    async refreshRecommendations(retryCount = 0, { advanceSearch = false } = {}) {
      const userStore = useUserStore()
      if (!userStore.canWriteGitHub && !userStore.hasAccount) {
        this.activeTab = 'trending'
        return this.loadTrendingFeed()
      }

      const sessionEpoch = userStore.sessionEpoch
      const currentRefreshSeq = ++this.refreshSeq
      const isStaleRun = () => sessionEpoch !== userStore.sessionEpoch || currentRefreshSeq !== this.refreshSeq

      this.recLoading = true
      this.recError = null

      try {
        // 0. 若已绑定云端且开启分析，优先尝试从服务端同步最新画像与搜索方向（失败不覆盖缓存）
        if (userStore.cloudSync?.cloudBound && userStore.cloudSync?.accountMatched && userStore.preferences?.analysisEnabled) {
          await userStore.refreshCloudPortraitData().catch(() => {})
          if (isStaleRun()) return
        }

        // 1. 一次性冻结快照（包含账号版本、云端画像缓存、featureSpace 与尚未被 processedThrough 覆盖的近期事件）
        const snapshot = await createSnapshot('profile', advanceSearch ? 'explore_next_round' : 'user_refresh')
        if (isStaleRun()) return

        const cloudState = snapshot.cloudPortraitState || userStore.cloudPortrait
        const canUseCloudPortrait = Boolean(
          userStore.preferences?.analysisEnabled !== false &&
          snapshot.cloudPortrait &&
          cloudState &&
          (cloudState.status === 'ready' || cloudState.status === 'stale')
        )

        this.portraitStatus = cloudState?.status || 'unbound'
        this.processedThrough = Number(snapshot.processedThrough || 0)
        this.unprocessedEventCount = Array.isArray(snapshot.unprocessedEvents) ? snapshot.unprocessedEvents.length : 0

        let activeProfile = null
        let searchSourceProfile = null

        if (canUseCloudPortrait) {
          this.rankingSource = 'cloud_portrait'
          this.modelVersion = cloudState.modelVersion || snapshot.cloudPortrait.modelVersion || null
          this.generationId = cloudState.generationId || snapshot.cloudPortrait.generationId || null
          activeProfile = snapshot.cloudPortrait
          this.recProfile = activeProfile
          searchSourceProfile = cloudState.searchPlan && Array.isArray(cloudState.searchPlan.queries) && cloudState.searchPlan.queries.length > 0
            ? { ...cloudState.searchPlan, directions: snapshot.cloudPortrait.directions, topInterests: snapshot.cloudPortrait.topInterests, languages: snapshot.cloudPortrait.languages }
            : snapshot.cloudPortrait
        } else {
          // 未取得云端正式画像时使用本地基线计算并明确标注来源，不伪装成已训练云端模型结果
          const profileCommit = await computeAndCommitProfile(snapshot)
          if (isStaleRun()) return
          if (!profileCommit.committed) {
            if (profileCommit.error === 'INPUT_CHANGED' && retryCount < 1) {
              return await this.refreshRecommendations(retryCount + 1, { advanceSearch })
            }
            throw new Error(profileCommit.error || '画像提交未通过快照校验')
          }
          activeProfile = profileCommit.profile
          this.recProfile = activeProfile
          searchSourceProfile = activeProfile
          this.rankingSource = (this.unprocessedEventCount > 0 && (!activeProfile?.evidenceRepos || activeProfile.evidenceRepos.length === 0))
            ? 'recent_only'
            : 'local_baseline'
          this.modelVersion = 'local-baseline-v1'
          this.generationId = null
        }

        // 2. 构建有界搜索计划（最多 4 查询 / 总计最多 8 页）
        if (!advanceSearch) {
          this.searchRound = 1
          this.searchPageCursors = {}
        } else {
          this.searchRound += 1
        }

        const planResult = planDiscoveryQueries(
          searchSourceProfile,
          advanceSearch ? [] : this.recentQueryStrings,
          Date.now(),
          { maxQueries: 4, maxTotalPages: 8, pageCursors: this.searchPageCursors }
        )
        const queryPlan = Array.isArray(planResult)
          ? planResult
          : (Array.isArray(planResult?.queryPlan) ? planResult.queryPlan : [])

        if (queryPlan.length > 0) {
          try {
            const discoveryRes = await refreshPersonalizedCandidates(queryPlan, { round: this.searchRound })
            if (isStaleRun()) return
            const queryReports = Array.isArray(discoveryRes?.queries) ? discoveryRes.queries : []
            const nextCursors = { ...this.searchPageCursors }
            for (const qr of queryReports) {
              if (qr?.id && qr.nextPage) {
                nextCursors[qr.id] = qr.nextPage
              }
            }
            this.searchPageCursors = nextCursors
            this.recentQueryStrings = Array.from(new Set([
              ...queryPlan.map(q => q.query).filter(Boolean),
              ...this.recentQueryStrings
            ])).slice(0, 16)
            this.searchSummary = {
              round: this.searchRound,
              queriesCount: queryReports.length || queryPlan.length,
              pagesUsed: discoveryRes?.pagesUsed ?? queryPlan.length,
              candidateCount: discoveryRes?.count ?? (discoveryRes?.candidates?.length || 0),
              bounded: true,
              complete: false,
              hasNextPages: Object.keys(nextCursors).length > 0,
              queries: queryReports
            }
          } catch (candErr) {
            console.warn('[FeedStore] 候选搜索提示:', candErr.message)
          }
        }

        if (isStaleRun()) return

        // 3. 重新冻结最新快照（纳入刚刚缓存的搜索候选，并核对账号、画像版本与隐藏项未漂移），交由 Worker 重排
        const rankSnapshot = await createSnapshot('ranking', advanceSearch ? 'explore_ranking' : 'ranking_compute')
        if (isStaleRun()) return

        const rankCloudState = rankSnapshot.cloudPortraitState || userStore.cloudPortrait || cloudState
        const effectiveUseCloud = Boolean(
          userStore.preferences?.analysisEnabled !== false &&
          rankSnapshot.cloudPortrait &&
          rankCloudState &&
          (rankCloudState.status === 'ready' || rankCloudState.status === 'stale')
        )

        this.portraitStatus = rankCloudState?.status || this.portraitStatus
        this.processedThrough = Number(rankSnapshot.processedThrough ?? this.processedThrough ?? 0)
        this.unprocessedEventCount = Array.isArray(rankSnapshot.unprocessedEvents)
          ? rankSnapshot.unprocessedEvents.length
          : this.unprocessedEventCount

        let rankingProfile = effectiveUseCloud ? rankSnapshot.cloudPortrait : activeProfile
        if (effectiveUseCloud) {
          this.rankingSource = 'cloud_portrait'
          this.modelVersion = rankCloudState.modelVersion || rankSnapshot.cloudPortrait.modelVersion || this.modelVersion
          this.generationId = rankCloudState.generationId || rankSnapshot.cloudPortrait.generationId || this.generationId
          this.recProfile = rankingProfile
        } else if (canUseCloudPortrait || !rankingProfile) {
          const fallbackCommit = await computeAndCommitProfile(rankSnapshot)
          if (isStaleRun()) return
          rankingProfile = fallbackCommit.profile
          this.recProfile = rankingProfile
          this.rankingSource = (this.unprocessedEventCount > 0 && (!rankingProfile?.evidenceRepos || rankingProfile.evidenceRepos.length === 0))
            ? 'recent_only'
            : 'local_baseline'
          this.modelVersion = 'local-baseline-v1'
          this.generationId = null
        }

        const rankCommit = await computeAndCommitRanking(
          rankSnapshot,
          rankingProfile,
          {
            cloudPortrait: effectiveUseCloud ? rankSnapshot.cloudPortrait : null,
            featureSpace: effectiveUseCloud ? rankSnapshot.featureSpace : null,
            unprocessedEvents: rankSnapshot.unprocessedEvents || [],
            processedThrough: rankSnapshot.processedThrough || 0
          }
        )
        if (isStaleRun()) return

        if (!rankCommit.committed) {
          if (rankCommit.error === 'INPUT_CHANGED' && retryCount < 1) {
            return await this.refreshRecommendations(retryCount + 1, { advanceSearch: false })
          }
          throw new Error(rankCommit.error || '推荐批次提交未通过快照校验')
        }

        const { batch } = rankCommit
        this.recBatchId = batch.batchId
        if (batch.modelVersion && effectiveUseCloud) {
          this.modelVersion = batch.modelVersion
        }
        this.unprocessedEventCount = batch.unprocessedEventCount ?? this.unprocessedEventCount

        // 4. 固定批次第 1 页读取（避免边滚动边重算造成重复或漏项）
        const firstPage = await listRecommendation(this.recBatchId, 0, 20)
        if (isStaleRun()) return
        this.recItems = firstPage.items || []
        this.recTotal = firstPage.total || 0
        this.recOffset = (firstPage.items || []).length
        this.recHasMore = firstPage.nextOffset !== null
      } catch (err) {
        if (isStaleRun()) return
        console.warn('[FeedStore] 推荐生成异常:', err.message)
        this.recError = err.message
        if (this.recItems.length === 0) {
          await this.loadTrendingFeed()
        }
      } finally {
        if (!isStaleRun()) {
          this.recLoading = false
        }
      }
    },

    async exploreNextSearchRound() {
      if (this.recLoading) return
      return this.refreshRecommendations(0, { advanceSearch: true })
    },

    async loadMoreRecommendations() {
      if (this.recLoading || !this.recHasMore || !this.recBatchId) return
      const userStore = useUserStore()
      const sessionEpoch = userStore.sessionEpoch
      const activeBatchId = this.recBatchId
      this.recLoading = true

      try {
        const page = await listRecommendation(activeBatchId, this.recOffset, 20)
        if (sessionEpoch !== userStore.sessionEpoch || activeBatchId !== this.recBatchId) return
        const newItems = page.items || []
        this.recItems = [...this.recItems, ...newItems]
        this.recOffset += newItems.length
        this.recHasMore = page.nextOffset !== null
      } catch (err) {
        console.warn('[FeedStore] 加载更多推荐失败:', err.message)
      } finally {
        this.recLoading = false
      }
    },

    async loadHiddenRecommendations() {
      this.hiddenLoading = true
      try {
        const items = await listHiddenRecommendations()
        this.hiddenItems = Array.isArray(items) ? items : []
        return this.hiddenItems
      } catch (err) {
        console.warn('[FeedStore] 读取已隐藏推荐列表失败:', err.message)
        return this.hiddenItems
      } finally {
        this.hiddenLoading = false
      }
    },

    async hideRecommendation(repoId) {
      const normalizedId = String(repoId)
      try {
        // 隐藏反馈会提升 feedback_revision，使正在进行的旧计算输入失效
        this.refreshSeq += 1
        await recordFeedback(normalizedId, 'hide', null, { hidden: true })
        this.recItems = this.recItems.filter(item =>
          String(item.repoId) !== normalizedId &&
          String(item.repository?.repoId || '') !== normalizedId &&
          String(item.repository?.canonicalKey || '') !== normalizedId
        )
        await this.loadHiddenRecommendations()
      } catch (err) {
        console.warn('[FeedStore] 隐藏候选失败:', err.message)
      }
    },

    async unhideRecommendation(repoId) {
      const normalizedId = String(repoId)
      try {
        this.refreshSeq += 1
        await recordFeedback(normalizedId, 'unhide', null, { hidden: false })
        this.hiddenItems = this.hiddenItems.filter(item => String(item.repoId) !== normalizedId)
        await this.refreshRecommendations(0, { advanceSearch: false })
      } catch (err) {
        console.warn('[FeedStore] 解除隐藏候选失败:', err.message)
        throw err
      }
    }
  }
})

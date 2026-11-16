/**
 * client/src/stores/feed.js
 * 推荐与热门双页签发现流状态管理 (依据 project.md 第二节、第九节与第十节)
 */

import { defineStore } from 'pinia'
import { loadTrending } from '../services/projects'
import {
  createSnapshot,
  computeAndCommitProfile,
  computeAndCommitRanking,
  listRecommendation,
  recordFeedback
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
    recError: null
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

    async refreshRecommendations(retryCount = 0) {
      const userStore = useUserStore()
      if (!userStore.canWriteGitHub && !userStore.hasAccount) {
        // 未登录则降级到热门
        this.activeTab = 'trending'
        return this.loadTrendingFeed()
      }

      this.recLoading = true
      this.recError = null

      try {
        // 1. 创建快照
        const snapshot = await createSnapshot('profile', 'user_refresh')

        // 2. Worker 计算画像并提交（若输入在计算期间变更则重排一次）
        const profileCommit = await computeAndCommitProfile(snapshot)
        if (!profileCommit.committed) {
          if (profileCommit.error === 'INPUT_CHANGED' && retryCount < 1) {
            return await this.refreshRecommendations(retryCount + 1)
          }
          throw new Error(profileCommit.error || '画像提交未通过快照校验')
        }
        const { profile } = profileCommit
        this.recProfile = profile

        // 3. 基于画像规划网页候选查询（兼容数组与 { queryPlan } 两种契约）
        const planResult = planDiscoveryQueries(profile, [], Date.now())
        const queryPlan = Array.isArray(planResult)
          ? planResult
          : (Array.isArray(planResult?.queryPlan) ? planResult.queryPlan : [])
        if (queryPlan.length > 0) {
          try {
            await refreshPersonalizedCandidates(queryPlan)
          } catch (candErr) {
            console.warn('[FeedStore] 候选搜索提示:', candErr.message)
          }
        }

        // 4. 读取最新快照并执行排序重排（校验快照输入版本）
        const rankSnapshot = await createSnapshot('ranking', 'ranking_compute')
        const rankCommit = await computeAndCommitRanking(rankSnapshot, profile)
        if (!rankCommit.committed) {
          if (rankCommit.error === 'INPUT_CHANGED' && retryCount < 1) {
            return await this.refreshRecommendations(retryCount + 1)
          }
          throw new Error(rankCommit.error || '推荐批次提交未通过快照校验')
        }
        const { batch } = rankCommit
        this.recBatchId = batch.batchId

        // 5. 读取批次第 1 页
        const firstPage = await listRecommendation(this.recBatchId, 0, 20)
        this.recItems = firstPage.items || []
        this.recTotal = firstPage.total || 0
        this.recOffset = (firstPage.items || []).length
        this.recHasMore = firstPage.nextOffset !== null
      } catch (err) {
        console.warn('[FeedStore] 推荐生成异常:', err.message)
        this.recError = err.message
        // 遇到错误或无数据时回退展示热门
        if (this.recItems.length === 0) {
          await this.loadTrendingFeed()
        }
      } finally {
        this.recLoading = false
      }
    },

    async loadMoreRecommendations() {
      if (this.recLoading || !this.recHasMore || !this.recBatchId) return
      this.recLoading = true

      try {
        const page = await listRecommendation(this.recBatchId, this.recOffset, 20)
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

    async hideRecommendation(repoId) {
      try {
        await recordFeedback(repoId, 'hide')
        this.recItems = this.recItems.filter(item => item.repoId !== repoId && item.repository?.repoId !== repoId)
      } catch (err) {
        console.warn('[FeedStore] 隐藏候选失败:', err.message)
      }
    }
  }
})

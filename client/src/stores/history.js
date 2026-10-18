import { defineStore } from 'pinia'
import {
  queryHistory,
  deleteHistory,
  clearHistory,
  countHistory
} from '../services/history'

export const useHistoryStore = defineStore('history', {
  state: () => ({
    items: [],
    nextCursor: null,
    total: 0,
    keyword: '',
    isLoading: false,
    isLoadingMore: false,
    requestSequence: 0,
    error: null
  }),

  getters: {
    hasMore: (state) => state.nextCursor !== null
  },

  actions: {
    async initializeForCurrentAccount() {
      this.reset()
      await this.loadFirstPage('')
    },

    async loadFirstPage(keyword = '') {
      const seq = ++this.requestSequence
      this.keyword = keyword
      this.isLoading = true
      this.error = null

      try {
        const res = await queryHistory({ cursor: null, limit: 30, keyword })
        // 如果在此期间有更新的请求发起，丢弃本次过期结果
        if (seq !== this.requestSequence) return

        this.items = res.items || []
        this.nextCursor = res.nextCursor || null
        this.total = typeof res.total === 'number' ? res.total : this.items.length
      } catch (err) {
        if (seq === this.requestSequence) {
          this.error = err.message || '加载浏览历史失败'
        }
      } finally {
        if (seq === this.requestSequence) {
          this.isLoading = false
        }
      }
    },

    async loadMore() {
      if (!this.nextCursor || this.isLoading || this.isLoadingMore) return
      const seq = this.requestSequence
      this.isLoadingMore = true

      try {
        const res = await queryHistory({
          cursor: this.nextCursor,
          limit: 30,
          keyword: this.keyword
        })
        if (seq !== this.requestSequence) return

        const newItems = res.items || []
        this.items = [...this.items, ...newItems]
        this.nextCursor = res.nextCursor || null
        if (typeof res.total === 'number') {
          this.total = res.total
        }
      } catch (err) {
        if (seq === this.requestSequence) {
          this.error = err.message || '加载更多历史失败'
        }
      } finally {
        if (seq === this.requestSequence) {
          this.isLoadingMore = false
        }
      }
    },

    async remove(repoId) {
      if (!repoId) return
      try {
        await deleteHistory(repoId)
        // 删除成功后重新加载当前搜索第一页，确保 total 与游标准确
        await this.loadFirstPage(this.keyword)
      } catch (err) {
        this.error = err.message || '删除历史记录失败'
        throw err
      }
    },

    async clearAll() {
      try {
        await clearHistory()
        this.items = []
        this.nextCursor = null
        this.total = 0
      } catch (err) {
        this.error = err.message || '清空历史记录失败'
        throw err
      }
    },

    async refreshAfterVisit() {
      // 最近访问可能让该仓库移动到列表顶部，重新从第一页刷新
      await this.loadFirstPage(this.keyword)
    },

    reset() {
      this.requestSequence++
      this.items = []
      this.nextCursor = null
      this.total = 0
      this.keyword = ''
      this.isLoading = false
      this.isLoadingMore = false
      this.error = null
    }
  }
})

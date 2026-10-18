import { defineStore } from 'pinia'
import {
  initializeApplication,
  startLogin as apiStartLogin,
  pollLogin as apiPollLogin,
  cancelLogin as apiCancelLogin,
  logout as apiLogout,
  forgetCurrentAccount as apiForgetCurrentAccount,
  saveModeSetting
} from '../services/auth'
import {
  syncProfile,
  syncRepositoryCollection,
  loadRepositoryPage,
  setStar as apiSetStar,
  deriveInterestTags,
  saveInterestPreferences
} from '../services/account'
import { useHistoryStore } from './history'
import { nativeBridge } from '../platform'

export const useUserStore = defineStore('user', {
  state: () => ({
    session: {
      status: 'guest', // 'guest' | 'authenticated' | 'offline' | 'reauthRequired'
      accountId: null,
      contextId: '',
      profile: null,
      verifiedAt: null
    },
    sessionEpoch: 0,
    bootStatus: 'starting', // 'starting' | 'ready' | 'storageError'
    authStage: 'idle', // 'idle' | 'requesting' | 'waiting' | 'verifying'
    authError: null,
    loginChallenge: null, // { challengeId, deviceCode, userCode, verificationUri, expiresIn, interval }
    preferences: {
      historyEnabled: true,
      manualTags: []
    },
    repos: [],
    stars: [],
    repoSync: {
      status: 'idle', // 'idle' | 'loading' | 'ready' | 'error'
      loadedCount: 0,
      complete: false,
      lastSyncedAt: null,
      errorCode: null,
      retryAt: null
    },
    starSync: {
      status: 'idle',
      loadedCount: 0,
      complete: false,
      lastSyncedAt: null,
      errorCode: null,
      retryAt: null
    },
    starPendingByRepo: {}
  }),

  getters: {
    hasAccount: (state) => Boolean(state.session?.accountId),
    isGuest: (state) => state.session?.status === 'guest',
    isOffline: (state) => state.session?.status === 'offline',
    needsReauth: (state) => state.session?.status === 'reauthRequired',
    canWriteGitHub: (state) => state.session?.status === 'authenticated' && state.authStage === 'idle',
    canRecordHistory: (state) =>
      state.authStage === 'idle' &&
      Boolean(state.preferences?.historyEnabled) &&
      ['authenticated', 'offline'].includes(state.session?.status),
    profile: (state) => state.session?.profile || null,
    interestTags: (state) =>
      deriveInterestTags(state.repos, state.stars, state.preferences?.manualTags || [])
  },

  actions: {
    /**
     * 应用启动初始化入口，全局只执行一次
     */
    async initialize() {
      try {
        const initData = await initializeApplication()
        if (initData.session) {
          this.session = initData.session
        }
        this.sessionEpoch++
        this.bootStatus = 'ready'

        if (this.hasAccount) {
          await this.loadCurrentAccountData()
        }

        return {
          mode: initData.mode || 'unset',
          shouldPromptLogin: Boolean(initData.shouldPromptLogin)
        }
      } catch (err) {
        console.error('[userStore] 初始化应用失败:', err)
        this.bootStatus = 'storageError'
        return {
          mode: 'unset',
          shouldPromptLogin: false
        }
      }
    },

    /**
     * 加载当前账号的本地快照、偏好与第一页列表
     */
    async loadCurrentAccountData() {
      if (!this.hasAccount) return
      const historyStore = useHistoryStore()

      try {
        // 读取本地账号快照 (profile, preferences, repoSync, starSync)
        const snapRes = await nativeBridge.invoke('account.readSnapshot')
        if (snapRes.ok && snapRes.data) {
          const snap = snapRes.data
          if (snap.profile && !this.session.profile) {
            this.session.profile = snap.profile
          }
          if (snap.preferences) {
            this.preferences = {
              historyEnabled: Boolean(snap.preferences.historyEnabled),
              manualTags: Array.isArray(snap.preferences.manualTags) ? snap.preferences.manualTags : []
            }
          }
          if (snap.repoSync) {
            this.repoSync = { ...this.repoSync, ...snap.repoSync }
          }
          if (snap.starSync) {
            this.starSync = { ...this.starSync, ...snap.starSync }
          }
        }

        // 读取本地缓存的公开仓库与 Star 第一页
        const [reposPage, starsPage] = await Promise.allSettled([
          loadRepositoryPage('repos', 0, 30),
          loadRepositoryPage('stars', 0, 30)
        ])

        if (reposPage.status === 'fulfilled' && reposPage.value?.items) {
          this.repos = reposPage.value.items
        }
        if (starsPage.status === 'fulfilled' && starsPage.value?.items) {
          this.stars = starsPage.value.items
        }

        // 初始化当前账号的浏览历史
        await historyStore.initializeForCurrentAccount()

        // 若处于在线已授权状态，检查是否需要进行后台数据刷新
        if (this.session.status === 'authenticated') {
          const now = Date.now()
          const reposStale = !this.repoSync.lastSyncedAt || now - this.repoSync.lastSyncedAt > 5 * 60 * 1000
          const starsStale = !this.starSync.lastSyncedAt || now - this.starSync.lastSyncedAt > 5 * 60 * 1000

          if (reposStale || starsStale || !this.repoSync.complete || !this.starSync.complete) {
            this.refreshAccountData().catch((e) => {
              console.warn('[userStore] 账号后台刷新失败:', e)
            })
          }
        }
      } catch (err) {
        console.warn('[userStore] 加载当前账号数据失败:', err)
      }
    },

    /**
     * 发起 GitHub 设备码授权登录
     */
    async startLogin() {
      this.authStage = 'requesting'
      this.authError = null
      this.loginChallenge = null

      try {
        const challenge = await apiStartLogin()
        this.loginChallenge = challenge
        this.authStage = 'waiting'
        this.pollLoginStatus(challenge.challengeId, challenge.interval || 5)
        return challenge
      } catch (err) {
        this.authStage = 'idle'
        this.authError = err.message || '发起授权请求失败'
        throw err
      }
    },

    /**
     * 内部轮询授权结果
     */
    async pollLoginStatus(challengeId, intervalSeconds) {
      const currentEpoch = this.sessionEpoch
      const delayMs = Math.max(3000, intervalSeconds * 1000)

      while (this.authStage === 'waiting' && this.loginChallenge?.challengeId === challengeId) {
        await new Promise((r) => setTimeout(r, delayMs))
        if (this.authStage !== 'waiting' || this.loginChallenge?.challengeId !== challengeId) {
          break
        }

        try {
          const progress = await apiPollLogin(challengeId)
          if (progress.status === 'success') {
            this.authStage = 'verifying'
            this.session = progress.session
            this.sessionEpoch++
            this.loginChallenge = null
            this.authStage = 'idle'
            this.authError = null

            // 登录成功后加载数据并启动列表同步
            await this.loadCurrentAccountData()
            this.refreshAccountData().catch(() => {})
            return
          }

          if (progress.status === 'pending') {
            // 继续等待
            continue
          }

          if (progress.status === 'slowDown') {
            // 减慢轮询频率
            await new Promise((r) => setTimeout(r, 5000))
            continue
          }

          if (progress.status === 'expired') {
            this.authStage = 'idle'
            this.authError = '验证码已过期，请重新发起登录'
            this.loginChallenge = null
            return
          }

          if (progress.status === 'denied') {
            this.authStage = 'idle'
            this.authError = '授权已被取消或拒绝'
            this.loginChallenge = null
            return
          }

          if (progress.status === 'error') {
            this.authStage = 'idle'
            this.authError = progress.error || '授权轮询异常'
            this.loginChallenge = null
            return
          }
        } catch (err) {
          if (this.authStage === 'waiting') {
            this.authStage = 'idle'
            this.authError = err.message || '网络连接失败'
            this.loginChallenge = null
          }
          return
        }
      }
    },

    /**
     * 取消进行中的登录流程
     */
    async cancelLogin() {
      if (this.loginChallenge) {
        const cid = this.loginChallenge.challengeId
        this.loginChallenge = null
        try {
          await apiCancelLogin(cid)
        } catch {
          // ignore
        }
      }
      this.authStage = 'idle'
      this.authError = null
    },

    /**
     * 跳过登录以游客模式浏览
     */
    async handleSkipLogin() {
      if (!this.hasAccount) {
        await saveModeSetting('guest')
        this.session = {
          status: 'guest',
          accountId: null,
          contextId: 'guest_' + Date.now(),
          profile: null,
          verifiedAt: null
        }
        this.sessionEpoch++
        this.repos = []
        this.stars = []
        useHistoryStore().reset()
      }
    },

    /**
     * 退出当前账号登录，转为游客模式
     */
    async logout() {
      try {
        await apiLogout()
      } catch (err) {
        console.warn('[userStore] 退出登录时后端失败:', err)
      }
      this.session = {
        status: 'guest',
        accountId: null,
        contextId: 'guest_' + Date.now(),
        profile: null,
        verifiedAt: null
      }
      this.sessionEpoch++
      this.repos = []
      this.stars = []
      this.repoSync = { status: 'idle', loadedCount: 0, complete: false, lastSyncedAt: null, errorCode: null, retryAt: null }
      this.starSync = { status: 'idle', loadedCount: 0, complete: false, lastSyncedAt: null, errorCode: null, retryAt: null }
      useHistoryStore().reset()
    },

    /**
     * 清除当前账号的全部本地持久数据（账号、缓存与历史）
     */
    async forgetAccount() {
      if (!this.hasAccount) return
      try {
        await apiForgetCurrentAccount()
      } catch (err) {
        console.warn('[userStore] 清除账号本地数据失败:', err)
      }
      this.session = {
        status: 'guest',
        accountId: null,
        contextId: 'guest_' + Date.now(),
        profile: null,
        verifiedAt: null
      }
      this.sessionEpoch++
      this.repos = []
      this.stars = []
      useHistoryStore().reset()
    },

    /**
     * 刷新当前账号所有数据 (公开资料、仓库、Star)
     */
    async refreshAccountData() {
      if (!this.hasAccount || this.session.status !== 'authenticated') return

      // 1. 同步个人资料
      try {
        const profile = await syncProfile()
        if (profile) {
          this.session.profile = profile
        }
      } catch (err) {
        console.warn('[userStore] 同步个人资料失败:', err)
      }

      // 2. 并行拉取公开仓库与 Star
      this.repoSync.status = 'loading'
      this.starSync.status = 'loading'

      const [reposSyncRes, starsSyncRes] = await Promise.allSettled([
        syncRepositoryCollection('repos', {
          login: this.session.profile?.login,
          onProgress: ({ loadedCount }) => {
            this.repoSync.loadedCount = loadedCount
          }
        }),
        syncRepositoryCollection('stars', {
          onProgress: ({ loadedCount }) => {
            this.starSync.loadedCount = loadedCount
          }
        })
      ])

      if (reposSyncRes.status === 'fulfilled' && !reposSyncRes.value.aborted) {
        this.repoSync = {
          status: 'ready',
          loadedCount: reposSyncRes.value.loadedCount,
          complete: reposSyncRes.value.complete,
          lastSyncedAt: reposSyncRes.value.lastSyncedAt,
          errorCode: null,
          retryAt: null
        }
        const p = await loadRepositoryPage('repos', 0, 30)
        this.repos = p.items || []
      } else if (reposSyncRes.status === 'rejected') {
        const err = reposSyncRes.reason
        this.repoSync.status = 'error'
        this.repoSync.errorCode = err.code || 'UNKNOWN'
        this.repoSync.retryAt = err.retryAfter || null
      }

      if (starsSyncRes.status === 'fulfilled' && !starsSyncRes.value.aborted) {
        this.starSync = {
          status: 'ready',
          loadedCount: starsSyncRes.value.loadedCount,
          complete: starsSyncRes.value.complete,
          lastSyncedAt: starsSyncRes.value.lastSyncedAt,
          errorCode: null,
          retryAt: null
        }
        const p = await loadRepositoryPage('stars', 0, 30)
        this.stars = p.items || []
      } else if (starsSyncRes.status === 'rejected') {
        const err = starsSyncRes.reason
        this.starSync.status = 'error'
        this.starSync.errorCode = err.code || 'UNKNOWN'
        this.starSync.retryAt = err.retryAfter || null
      }
    },

    /**
     * 对指定仓库执行 Star 或取消 Star
     */
    async setStar(repository, starred) {
      if (!repository || !repository.repoId) return { success: false, error: '无效仓库' }
      if (!this.canWriteGitHub) {
        return { success: false, error: '请先登录 GitHub' }
      }

      this.starPendingByRepo[repository.repoId] = true

      try {
        const result = await apiSetStar(repository, starred)
        if (result.success) {
          if (starred) {
            // 加入到本地 stars 列表头部
            const exists = this.stars.some((r) => r.repoId === repository.repoId)
            if (!exists) {
              this.stars = [repository, ...this.stars]
              this.starSync.loadedCount++
            }
          } else {
            // 从本地 stars 列表移除
            const idx = this.stars.findIndex((r) => r.repoId === repository.repoId)
            if (idx >= 0) {
              this.stars.splice(idx, 1)
              this.starSync.loadedCount = Math.max(0, this.starSync.loadedCount - 1)
            }
          }
        }
        return result
      } finally {
        this.starPendingByRepo[repository.repoId] = false
      }
    },

    /**
     * 更新浏览历史开启/关闭偏好
     */
    async setHistoryEnabled(enabled) {
      this.preferences.historyEnabled = enabled
      await nativeBridge.invoke('account.savePreferences', {
        historyEnabled: enabled,
        manualTags: this.preferences.manualTags
      })
    },

    /**
     * 保存用户手选的技术兴趣标签
     */
    async saveManualTags(tags) {
      const saved = await saveInterestPreferences(tags)
      this.preferences.manualTags = saved
      return saved
    }
  }
})

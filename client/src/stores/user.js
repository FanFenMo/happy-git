/**
 * client/src/stores/user.js
 * 当前会话、账号资料与集合同步状态管理 (依据 project.md 第四节、第五节与第十一节)
 */

import { defineStore } from 'pinia'
import {
  initializeApplication,
  beginLogin as apiBeginLogin,
  getLoginTask as apiGetLoginTask,
  cancelLogin as apiCancelLogin,
  logout as apiLogout,
  forgetCurrentAccount as apiForgetCurrentAccount
} from '../services/session'
import {
  readAccountSnapshot,
  syncAccount as apiSyncAccount,
  readTask as apiReadTask,
  cancelTask as apiCancelTask,
  listRepositories,
  loadAllRepositories,
  setStar as apiSetStar,
  savePreferences as apiSavePreferences
} from '../services/account'
import { useHistoryStore } from './history'
import { nativeBridge } from '../platform'

const emptySync = () => ({
  status: 'idle',
  loadedCount: 0,
  complete: false,
  lastSyncedAt: null,
  errorCode: null,
  retryAt: null
})

const emptyPage = () => ({
  nextOffset: null,
  total: null,
  loading: false
})

const emptyPreferences = () => ({
  historyEnabled: true,
  manualTags: []
})

export const useUserStore = defineStore('user', {
  state: () => ({
    session: {
      status: 'guest',
      accountId: null,
      contextId: null,
      profile: null,
      verifiedAt: null
    },
    sessionEpoch: 0,
    loginSequence: 0,
    loginChallenge: null,
    bootStatus: 'starting',
    authStage: 'idle', // 'idle' | 'opening' | 'waiting' | 'verifying'
    authError: null,
    activeLoginTaskId: null,
    preferences: emptyPreferences(),
    repos: [],
    stars: [],
    interestRepos: [],
    interestStars: [],
    repoSync: emptySync(),
    starSync: emptySync(),
    repoPage: emptyPage(),
    starPage: emptyPage(),
    starPendingByRepo: {},
    refreshing: false,
    activeSyncTaskId: null
  }),

  getters: {
    hasAccount: (state) => Boolean(state.session.accountId),
    isGuest: (state) => state.session.status === 'guest',
    isOffline: (state) => state.session.status === 'offline',
    needsReauth: (state) => state.session.status === 'reauth_required',
    canWriteGitHub: (state) => state.session.status === 'authenticated' && state.authStage === 'idle',
    canRecordHistory: (state) => state.preferences.historyEnabled && ['authenticated', 'offline'].includes(state.session.status),
    profile: (state) => state.session.profile,
    manualTags: (state) => state.preferences.manualTags || [],
    interestTags: (state) => state.preferences.manualTags || []
  },

  actions: {
    applySession(session) {
      this.sessionEpoch++
      this.session = session || { status: 'guest', accountId: null, contextId: null, profile: null, verifiedAt: null }
      if (session?.contextId) {
        nativeBridge.setContext(session.contextId)
      }
      this.repos = []
      this.stars = []
      this.preferences = emptyPreferences()
      this.repoSync = emptySync()
      this.starSync = emptySync()
      this.repoPage = emptyPage()
      this.starPage = emptyPage()
      this.starPendingByRepo = {}
      this.refreshing = false
      this.activeSyncTaskId = null
      useHistoryStore().reset()
    },

    async initialize() {
      nativeBridge.onAuthRequired = () => {
        if (this.hasAccount) this.session.status = 'reauth_required'
      }

      try {
        const data = await initializeApplication()
        this.applySession(data.session)
        this.bootStatus = 'ready'

        if (this.hasAccount) {
          await this.loadCurrentAccountData()
        }
        return { mode: data.mode, shouldPromptLogin: data.shouldPromptLogin }
      } catch (error) {
        this.bootStatus = 'storageError'
        this.authError = error.message
        return { mode: 'unset', shouldPromptLogin: false }
      }
    },

    async loadCurrentAccountData() {
      if (!this.hasAccount) return
      const epoch = this.sessionEpoch

      try {
        const snap = await readAccountSnapshot()
        if (epoch !== this.sessionEpoch) return

        if (snap.profile) this.session.profile = snap.profile
        this.preferences = snap.preferences || emptyPreferences()
        this.repoSync = { ...emptySync(), ...snap.repoSync }
        this.starSync = { ...emptySync(), ...snap.starSync }

        await Promise.all([
          this.loadCollection('repos'),
          this.loadCollection('stars'),
          useHistoryStore().initializeForCurrentAccount()
        ])

        if (epoch !== this.sessionEpoch) return

        // 若尚未同步过或同步不完整，触发低优先级同步
        if (this.session.status === 'authenticated' && (!this.repoSync.complete || !this.starSync.complete)) {
          this.refreshAccountData().catch(err => {
            if (epoch === this.sessionEpoch) this.authError = err.message
          })
        }
      } catch (err) {
        console.warn('[UserStore] 读取账号快照失败:', err.message)
      }
    },

    async loadCollection(kind, more = false) {
      const epoch = this.sessionEpoch
      const pageKey = kind === 'repos' ? 'repoPage' : 'starPage'
      const current = this[pageKey]
      if (current.loading || (more && current.nextOffset === null)) return

      current.loading = true
      try {
        const offset = more ? current.nextOffset : 0
        const page = await listRepositories(kind, offset, 30)
        if (epoch !== this.sessionEpoch) return

        this[kind] = more ? [...this[kind], ...page.items] : page.items
        this[pageKey] = {
          total: page.total,
          nextOffset: page.nextOffset,
          loading: false
        }
        if (!more) {
          const all = await loadAllRepositories(kind)
          if (epoch === this.sessionEpoch) this[kind === 'repos' ? 'interestRepos' : 'interestStars'] = all
        }
      } finally {
        if (epoch === this.sessionEpoch) this[pageKey].loading = false
      }
    },

    async startLogin(intent = 'login') {
      const sequence = ++this.loginSequence
      this.authStage = 'opening'
      this.authError = null

      try {
        const { loginTaskId, state } = await apiBeginLogin(intent)
        if (sequence !== this.loginSequence) return

        this.activeLoginTaskId = loginTaskId
        this.authStage = state || 'waiting'

        // 轮询本地登录任务状态 (每 1000ms 一次，任务结束立即终止)
        this.pollLoginStatus(loginTaskId, sequence)
      } catch (error) {
        if (sequence === this.loginSequence) {
          this.authStage = 'idle'
          this.authError = error.message
        }
        throw error
      }
    },

    async pollLoginStatus(taskId, sequence, intervalMs = 1000) {
      const active = () =>
        sequence === this.loginSequence &&
        (!this.activeLoginTaskId || this.activeLoginTaskId === taskId || this.loginChallenge?.challengeId === taskId)

      while (active()) {
        await new Promise(r => setTimeout(r, intervalMs))
        if (!active()) return

        try {
          const task = await apiGetLoginTask(taskId)
          if (!active()) return

          if (!task || !task.state) {
            this.authStage = 'idle'
            this.activeLoginTaskId = null
            this.loginChallenge = null
            return
          }

          if (task.state === 'authenticated' && task.session) {
            this.authStage = 'verifying'
            this.applySession(task.session)
            this.authStage = 'idle'
            this.authError = null
            this.activeLoginTaskId = null
            this.loginChallenge = null
            await this.loadCurrentAccountData()
            return
          }

          if (task.state === 'cancelled') {
            this.authStage = 'idle'
            this.activeLoginTaskId = null
            this.loginChallenge = null
            return
          }

          if (task.state === 'failed') {
            this.authStage = 'idle'
            this.authError = task.error?.message || '登录失败，请重试'
            this.activeLoginTaskId = null
            this.loginChallenge = null
            return
          }

          this.authStage = task.state // 'waiting' or 'verifying'
        } catch (err) {
          if (active()) {
            this.authStage = 'idle'
            this.authError = err.message
            this.activeLoginTaskId = null
            this.loginChallenge = null
          }
          return
        }
      }
    },

    async cancelLogin() {
      this.loginSequence++
      const taskId = this.activeLoginTaskId
      this.activeLoginTaskId = null
      this.authStage = 'idle'
      this.authError = null
      if (taskId) {
        await apiCancelLogin(taskId).catch(() => {})
      }
    },

    async handleSkipLogin() {
      await this.cancelLogin()
    },

    async logout() {
      await this.cancelLogin()
      const session = await apiLogout()
      this.applySession(session)
    },

    async forgetAccount() {
      await this.cancelLogin()
      const session = await apiForgetCurrentAccount()
      this.applySession(session)
    },

    async refreshAccountData(force = false) {
      if (!this.hasAccount || this.refreshing) return
      this.refreshing = true
      this.repoSync.status = 'loading'
      this.starSync.status = 'loading'

      try {
        const { taskId } = await apiSyncAccount(['profile', 'repos', 'stars'], force)
        this.activeSyncTaskId = taskId

        // 轮询同步进度
        const poll = async () => {
          if (!this.activeSyncTaskId || this.activeSyncTaskId !== taskId) return
          try {
            const task = await apiReadTask(taskId)
            if (!task || task.isEnded) {
              this.refreshing = false
              this.activeSyncTaskId = null
              await this.loadCollection('repos')
              await this.loadCollection('stars')
              const snap = await readAccountSnapshot()
              this.repoSync = { ...emptySync(), ...snap.repoSync }
              this.starSync = { ...emptySync(), ...snap.starSync }
              if (snap.profile) this.session.profile = snap.profile
              return
            }
            setTimeout(poll, 1000)
          } catch (_) {
            this.refreshing = false
            this.activeSyncTaskId = null
          }
        }
        setTimeout(poll, 1000)
      } catch (err) {
        this.refreshing = false
        this.authError = err.message
      }
    },

    async setStar(repository, desiredStarred) {
      if (!this.canWriteGitHub) {
        return { confirmed: false, error: '请登录 GitHub 后操作' }
      }

      const id = repository.repoId || repository.canonicalKey
      if (this.starPendingByRepo[id]) {
        return { confirmed: false, error: '正在操作中，请稍候' }
      }

      this.starPendingByRepo[id] = true
      try {
        const result = await apiSetStar(repository, desiredStarred)
        if (result.confirmed) {
          await this.loadCollection('stars')
          const snap = await readAccountSnapshot()
          this.starSync = { ...this.starSync, ...snap.starSync }
        }
        return result
      } finally {
        this.starPendingByRepo[id] = false
      }
    },

    async setHistoryEnabled(enabled) {
      await apiSavePreferences({
        historyEnabled: enabled,
        manualTags: this.preferences.manualTags
      })
      this.preferences.historyEnabled = enabled
    },

    async saveManualTags(tags) {
      await apiSavePreferences({
        historyEnabled: this.preferences.historyEnabled,
        manualTags: tags
      })
      this.preferences.manualTags = tags
      return tags
    }
  }
})

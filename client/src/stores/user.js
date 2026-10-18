import { defineStore } from 'pinia'
import { initializeApplication, startLogin as apiStartLogin, pollLogin as apiPollLogin,
  cancelLogin as apiCancelLogin, logout as apiLogout, forgetCurrentAccount as apiForgetCurrentAccount,
  saveModeSetting } from '../services/auth'
import { syncProfile, syncRepositoryCollection, loadRepositoryPage, loadAllRepositories,
  setStar as apiSetStar, deriveInterestTags, saveInterestPreferences, resetAccountTasks } from '../services/account'
import { useHistoryStore } from './history'
import { nativeBridge } from '../platform'

const emptySync = () => ({ status: 'idle', loadedCount: 0, complete: false, lastSyncedAt: null, errorCode: null, retryAt: null })
const emptyPage = () => ({ nextOffset: null, total: null, loading: false })
const emptyPreferences = () => ({ historyEnabled: false, manualTags: [] })

export const useUserStore = defineStore('user', {
  state: () => ({
    session: { status: 'guest', accountId: null, contextId: null, profile: null, verifiedAt: null },
    sessionEpoch: 0, loginSequence: 0, bootStatus: 'starting', authStage: 'idle', authError: null,
    loginChallenge: null, preferences: emptyPreferences(), repos: [], stars: [],
    interestRepos: [], interestStars: [], repoSync: emptySync(), starSync: emptySync(),
    repoPage: emptyPage(), starPage: emptyPage(), starPendingByRepo: {}, refreshing: false
  }),
  getters: {
    hasAccount: state => Boolean(state.session.accountId),
    isGuest: state => state.session.status === 'guest',
    isOffline: state => state.session.status === 'offline',
    needsReauth: state => state.session.status === 'reauthRequired',
    canWriteGitHub: state => state.session.status === 'authenticated' && state.authStage === 'idle',
    canRecordHistory: state => state.authStage === 'idle' && state.preferences.historyEnabled && ['authenticated', 'offline'].includes(state.session.status),
    profile: state => state.session.profile,
    interestTags: state => deriveInterestTags(state.interestRepos, state.interestStars, state.preferences.manualTags)
  },
  actions: {
    applySession(session) {
      resetAccountTasks()
      this.sessionEpoch++
      this.session = session
      nativeBridge.setContext(session.contextId)
      this.repos = []; this.stars = []; this.interestRepos = []; this.interestStars = []
      this.preferences = emptyPreferences()
      this.repoSync = emptySync(); this.starSync = emptySync()
      this.repoPage = emptyPage(); this.starPage = emptyPage()
      this.starPendingByRepo = {}; this.refreshing = false
      useHistoryStore().reset()
    },
    async initialize() {
      nativeBridge.onAuthRequired = () => { if (this.hasAccount) this.session.status = 'reauthRequired' }
      try {
        const data = await initializeApplication()
        this.applySession(data.session)
        this.bootStatus = 'ready'
        if (this.hasAccount) await this.loadCurrentAccountData()
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
      const snapshot = await nativeBridge.invoke('account.readSnapshot')
      if (epoch !== this.sessionEpoch) return
      if (!snapshot.ok) throw new Error(snapshot.error?.message || '读取账号数据失败')
      const snap = snapshot.data
      if (snap.profile) this.session.profile = snap.profile
      this.preferences = snap.preferences || emptyPreferences()
      this.repoSync = { ...emptySync(), ...snap.repoSync }
      this.starSync = { ...emptySync(), ...snap.starSync }
      await Promise.all([this.loadCollection('repos'), this.loadCollection('stars'), useHistoryStore().initializeForCurrentAccount()])
      if (epoch !== this.sessionEpoch) return
      if (this.session.status === 'authenticated' && [this.repoSync, this.starSync].some(sync => !sync.complete || Date.now() - (sync.lastSyncedAt || 0) > 300000))
        this.refreshAccountData().catch(error => { if (epoch === this.sessionEpoch) this.authError = error.message })
    },
    async loadCollection(kind, more = false) {
      const epoch = this.sessionEpoch
      const pageKey = kind === 'repos' ? 'repoPage' : 'starPage'
      const current = this[pageKey]
      if (current.loading || (more && current.nextOffset === null)) return
      current.loading = true
      try {
        const page = await loadRepositoryPage(kind, more ? current.nextOffset : 0, 30)
        if (epoch !== this.sessionEpoch) return
        this[kind] = more ? [...this[kind], ...page.items] : page.items
        this[pageKey] = { total: page.total, nextOffset: page.nextOffset, loading: false }
        if (!more) {
          const all = await loadAllRepositories(kind)
          if (epoch === this.sessionEpoch) this[kind === 'repos' ? 'interestRepos' : 'interestStars'] = all
        }
      } finally { if (epoch === this.sessionEpoch) this[pageKey].loading = false }
    },
    async startLogin() {
      const sequence = ++this.loginSequence
      this.authStage = 'requesting'; this.authError = null
      try {
        const previous = this.loginChallenge?.challengeId
        this.loginChallenge = null
        await apiCancelLogin(previous)
        if (sequence !== this.loginSequence) return
        const challenge = await apiStartLogin()
        if (sequence !== this.loginSequence) { await apiCancelLogin(challenge.challengeId); return }
        this.loginChallenge = challenge
        this.authStage = 'waiting'
        const opened = await nativeBridge.invoke('external.open', { url: challenge.authorizationUrl })
        if (sequence !== this.loginSequence) return
        if (!opened.ok) this.authError = '浏览器未打开，请点击下方按钮重试'
        this.pollLoginStatus(challenge.challengeId, sequence, challenge.intervalMs || 1500)
        return challenge
      } catch (error) {
        if (sequence === this.loginSequence) { this.authStage = 'idle'; this.authError = error.message }
        throw error
      }
    },
    async pollLoginStatus(id, sequence, intervalMs) {
      let nextPollAt = Date.now() + intervalMs
      const active = () => sequence === this.loginSequence && this.loginChallenge?.challengeId === id
      while (active()) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, nextPollAt - Date.now())))
        if (!active()) return
        try {
          const progress = await apiPollLogin(id)
          if (!active()) return
          if (progress.state === 'authenticated') {
            this.authStage = 'verifying'
            this.applySession(progress.session)
            this.loginChallenge = null; this.authStage = 'idle'; this.authError = null
            await this.loadCurrentAccountData()
            return
          }
          if (['pending', 'slowDown'].includes(progress.state)) { nextPollAt = progress.nextPollAt || Date.now() + intervalMs; continue }
          this.authError = progress.state === 'expired' ? '授权已过期，请重新登录' : progress.state === 'denied' ? '已取消 GitHub 授权' : '授权未完成，请重新登录'
          this.authStage = 'idle'; this.loginChallenge = null
          return
        } catch (error) {
          if (active()) { this.authStage = 'idle'; this.authError = error.message; this.loginChallenge = null }
          return
        }
      }
    },
    async cancelLogin() {
      this.loginSequence++
      const id = this.loginChallenge?.challengeId
      this.loginChallenge = null; this.authStage = 'idle'; this.authError = null
      await apiCancelLogin(id)
    },
    async handleSkipLogin() {
      await this.cancelLogin()
      if (!this.hasAccount) await saveModeSetting('guest')
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
    async refreshAccountData() {
      if (!this.hasAccount || this.session.status !== 'authenticated' || this.refreshing) return
      const epoch = this.sessionEpoch
      this.refreshing = true
      this.repoSync.status = 'loading'; this.starSync.status = 'loading'
      try {
        const results = await Promise.allSettled([syncProfile(), syncRepositoryCollection('repos', { login: this.profile?.login }), syncRepositoryCollection('stars')])
        if (epoch !== this.sessionEpoch) return
        if (results[0].status === 'fulfilled') this.session.profile = results[0].value
        for (const [index, kind, syncKey] of [[1, 'repos', 'repoSync'], [2, 'stars', 'starSync']]) {
          const result = results[index]
          if (result.status === 'fulfilled' && !result.value.aborted) {
            this[syncKey] = { ...emptySync(), ...result.value, status: 'ready' }
            await this.loadCollection(kind)
          } else if (result.status === 'rejected') {
            this[syncKey] = { ...this[syncKey], status: 'error', errorCode: result.reason.code || 'SYNC_FAILED', retryAt: result.reason.retryAt || null }
          } else this[syncKey].status = 'idle'
          if (epoch !== this.sessionEpoch) return
        }
      } finally { if (epoch === this.sessionEpoch) this.refreshing = false }
    },
    async setStar(repository, starred) {
      if (!this.canWriteGitHub) return { success: false, error: '请登录 GitHub 后重试' }
      const id = repository.repoId, epoch = this.sessionEpoch
      if (this.starPendingByRepo[id]) return { success: false, error: '正在更新，请稍候' }
      this.starPendingByRepo[id] = true
      try {
        const result = await apiSetStar(repository, starred)
        if (epoch !== this.sessionEpoch) return { success: false, error: '账号已变化' }
        if (result.success && result.cacheSaved) {
          await this.loadCollection('stars')
          const snap = await nativeBridge.invoke('account.readSnapshot')
          if (epoch === this.sessionEpoch && snap.ok) this.starSync = { ...this.starSync, ...snap.data.starSync }
        }
        return result
      } finally { if (epoch === this.sessionEpoch) this.starPendingByRepo[id] = false }
    },
    async setHistoryEnabled(enabled) {
      const epoch = this.sessionEpoch
      const res = await nativeBridge.invoke('account.savePreferences', { historyEnabled: enabled, manualTags: this.preferences.manualTags })
      if (!res.ok) throw new Error(res.error?.message || '保存历史设置失败')
      if (epoch === this.sessionEpoch) this.preferences.historyEnabled = enabled
    },
    async saveManualTags(tags) {
      const epoch = this.sessionEpoch, saved = await saveInterestPreferences(tags)
      if (epoch === this.sessionEpoch) this.preferences.manualTags = saved
      return saved
    }
  }
})

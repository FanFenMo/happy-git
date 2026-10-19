/**
 * client/electron/session-manager.cjs
 * 网页会话与活动账号生命周期管理器 (依据 project.md 第四节与第五节)
 */

const { randomUUID } = require('node:crypto')

class SessionManager {
  constructor({ database, browser, scheduler, pageExecutorFactory }) {
    this.database = database
    this.browser = browser
    this.scheduler = scheduler
    this.pageExecutorFactory = pageExecutorFactory

    this.currentContext = {
      contextId: randomUUID(),
      accountId: null,
      login: null,
      status: 'guest',
      verifiedAt: null,
      profile: null
    }

    this.loginTasks = new Map() // loginTaskId -> { state, intent, session, error }
  }

  generateContextId() {
    return randomUUID()
  }

  getContext() {
    return { ...this.currentContext }
  }

  assertContext(contextId) {
    if (contextId && this.currentContext.contextId !== contextId) {
      const err = new Error('SESSION_CHANGED')
      err.code = 'SESSION_CHANGED'
      throw err
    }
  }

  async initialize() {
    this.browser.initialize()
    return this.restoreSession()
  }

  async restoreSession() {
    this.currentContext.status = 'restoring'

    try {
      const activeAccountId = await this.database.callDatabase('readSetting', { key: 'active_account_id' })
      if (!activeAccountId) {
        this.currentContext = {
          contextId: this.generateContextId(),
          accountId: null,
          login: null,
          status: 'guest',
          verifiedAt: null,
          profile: null
        }
        return this.getContext()
      }

      // 读取本地快照
      const snapshot = await this.database.callDatabase('readAccountSnapshot', { accountId: activeAccountId })
      if (!snapshot || !snapshot.profile) {
        this.currentContext = {
          contextId: this.generateContextId(),
          accountId: null,
          login: null,
          status: 'guest',
          verifiedAt: null,
          profile: null
        }
        return this.getContext()
      }

      this.currentContext = {
        contextId: this.generateContextId(),
        accountId: activeAccountId,
        login: snapshot.profile.login,
        status: 'authenticated',
        verifiedAt: Date.now(),
        profile: snapshot.profile
      }

      // 在后台低频复核远端身份
      setImmediate(async () => {
        try {
          await this.scheduler.withPageLease(this.currentContext, 'verify', async () => {
            const workPage = this.browser.getOrCreateWorkPage()
            const executor = this.pageExecutorFactory(workPage.webContents)
            await executor.navigate('https://github.com', 15000)
            const identity = await executor.executeScript('readCurrentIdentity')

            if (identity?.kind === 'anonymous') {
              this.currentContext.status = 'reauth_required'
            } else if (identity?.kind === 'authenticated' && identity.login !== snapshot.profile.login) {
              console.warn('[SessionManager] 网站检测到不同账号，需重新认证')
              this.currentContext.status = 'reauth_required'
            }
          })
        } catch (err) {
          if (err.code === 'NETWORK_UNAVAILABLE' || err.code === 'PAGE_TIMEOUT') {
            this.currentContext.status = 'offline'
          }
        }
      })

      return this.getContext()
    } catch (err) {
      console.warn('[SessionManager] 恢复会话异常:', err.message)
      this.currentContext.status = 'guest'
      return this.getContext()
    }
  }

  beginLogin({ intent = 'login' }) {
    const loginTaskId = 'login_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
    const taskRecord = {
      loginTaskId,
      state: 'opening',
      intent,
      session: null,
      error: null
    }
    this.loginTasks.set(loginTaskId, taskRecord)

    this.browser.openLoginWindow({
      loginTaskId,
      onStateChange: (state) => {
        const t = this.loginTasks.get(loginTaskId)
        if (t && t.state !== 'cancelled' && t.state !== 'authenticated') {
          t.state = state
        }
      },
      onIdentityDetected: async (identity) => {
        try {
          const context = await this.activateIdentity(identity, loginTaskId)
          const t = this.loginTasks.get(loginTaskId)
          if (t) {
            t.state = 'authenticated'
            t.session = context
          }
        } catch (err) {
          const t = this.loginTasks.get(loginTaskId)
          if (t) {
            t.state = 'failed'
            t.error = { code: 'ACTIVATE_FAILED', message: err.message }
          }
        }
      },
      onClosed: () => {
        const t = this.loginTasks.get(loginTaskId)
        if (t && t.state !== 'authenticated') {
          t.state = 'cancelled'
        }
      }
    })

    return {
      loginTaskId,
      state: 'opening'
    }
  }

  getLoginTask({ loginTaskId }) {
    const task = this.loginTasks.get(loginTaskId)
    if (!task) {
      return { state: 'failed', error: { code: 'TASK_NOT_FOUND', message: '登录任务不存在' } }
    }
    return {
      loginTaskId: task.loginTaskId,
      state: task.state,
      session: task.session,
      error: task.error
    }
  }

  cancelLogin({ loginTaskId }) {
    const task = this.loginTasks.get(loginTaskId)
    if (task) {
      task.state = 'cancelled'
    }
    this.browser.closeLoginWindow()
    return { cancelled: true }
  }

  async activateIdentity(identity, loginTaskId) {
    const task = this.loginTasks.get(loginTaskId)
    if (!task || task.state === 'cancelled') {
      throw new Error('LOGIN_TASK_INVALID')
    }

    // 取消旧任务
    this.scheduler.cancelAllForContext(this.currentContext.contextId)

    // 读取该登录名资料以补齐数字 ID
    let accountId = identity.accountId
    let profileData = {
      accountId: accountId || null,
      login: identity.login,
      displayName: identity.login,
      avatarUrl: null,
      profileUrl: `https://github.com/${identity.login}`,
      bio: null,
      location: null,
      company: null,
      publicRepoCount: null,
      followerCount: null,
      followingCount: null,
      countPrecision: {},
      fetchedAt: Date.now()
    }

    try {
      const workPage = this.browser.getOrCreateWorkPage()
      const executor = this.pageExecutorFactory(workPage.webContents)
      const profile = await executor.runTask({
        scriptId: 'readProfile',
        url: `https://github.com/${identity.login}`,
        args: { expectedLogin: identity.login }
      })
      if (profile) {
        profileData = profile
        if (!accountId && profile.accountId) {
          accountId = profile.accountId
        }
      }
    } catch (err) {
      console.warn('[SessionManager] 读取完整资料补齐 ID 警告:', err.message)
    }

    // 若依然无数字 ID，使用 login 作为稳定临时 accountId
    const finalAccountId = accountId ? String(accountId) : identity.login
    profileData.accountId = finalAccountId

    // 保存至数据库
    await this.database.callDatabase('saveProfile', { accountId: finalAccountId, profile: profileData })
    await this.database.callDatabase('saveSetting', { key: 'active_account_id', value: finalAccountId })

    this.currentContext = {
      contextId: this.generateContextId(),
      accountId: finalAccountId,
      login: identity.login,
      status: 'authenticated',
      verifiedAt: Date.now(),
      profile: profileData
    }

    return this.getContext()
  }

  async logout() {
    this.currentContext.status = 'logging_out'
    this.scheduler.cancelAllForContext(this.currentContext.contextId)

    await this.browser.clearSessionData()
    await this.database.callDatabase('saveSetting', { key: 'active_account_id', value: null })

    this.currentContext = {
      contextId: this.generateContextId(),
      accountId: null,
      login: null,
      status: 'guest',
      verifiedAt: null,
      profile: null
    }

    return this.getContext()
  }

  async forgetCurrentAccount() {
    const accountId = this.currentContext.accountId
    await this.logout()
    if (accountId) {
      await this.database.callDatabase('forgetAccount', { accountId })
    }
    return { ok: true }
  }
}

module.exports = {
  SessionManager
}

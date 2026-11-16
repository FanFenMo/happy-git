/**
 * client/electron/ipc-router.cjs
 * 安全 NativeBridge IPC 路由与操作分发 (依据 project.md 第四节及阶段二云端协同契约)
 */

const { shell } = require('electron')
const { CloudService } = require('./cloud-service.cjs')

class IpcRouter {
  constructor({ sessionManager, accountSyncService, starService, cloudService = null, database, browser, scheduler, pageExecutorFactory, routes }) {
    this.sessionManager = sessionManager
    this.accountSyncService = accountSyncService
    this.starService = starService
    this.database = database
    this.browser = browser
    this.scheduler = scheduler
    this.pageExecutorFactory = pageExecutorFactory
    this.routes = routes
    this.cloudService = cloudService || new CloudService({ database })
  }

  async handleInvoke(event, { operation, payload = {}, contextId = null }) {
    const currentContext = this.sessionManager.getContext()

    const personalOps = [
      'account.readSnapshot', 'account.sync', 'repositories.list',
      'stars.set', 'history.record', 'history.list', 'history.delete', 'history.clear',
      'account.savePreferences', 'account.forgetLocalData', 'recommendation.createSnapshot',
      'recommendation.commit', 'recommendation.list', 'recommendation.feedback',
      'cloud.auth.begin', 'cloud.auth.poll', 'cloud.session.restore', 'cloud.session.logout',
      'cloud.sync.readState', 'cloud.sync.flush', 'cloud.preferences.save',
      'cloud.analysis.reset', 'cloud.collections.sync'
    ]

    if (personalOps.includes(operation)) {
      if (contextId && currentContext.contextId !== contextId) {
        return {
          ok: false,
          error: { code: 'SESSION_CHANGED', message: '会话已变更，请刷新状态' },
          contextId: currentContext.contextId
        }
      }
      if (currentContext.status === 'guest') {
        return {
          ok: false,
          error: { code: 'AUTH_REQUIRED', message: '该操作需要先登录 GitHub' },
          contextId: currentContext.contextId
        }
      }
    }

    try {
      const data = await this.dispatch(operation, payload, currentContext)
      return {
        ok: true,
        data,
        contextId: this.sessionManager.getContext().contextId
      }
    } catch (err) {
      console.warn(`[IpcRouter] 操作 ${operation} 失败:`, err.message)
      return {
        ok: false,
        error: {
          code: err.code || 'INTERNAL_ERROR',
          message: err.message || '内部错误'
        },
        contextId: this.sessionManager.getContext().contextId
      }
    }
  }

  async dispatch(operation, payload, context) {
    switch (operation) {
      case 'app.initialize': {
        const session = await this.sessionManager.restoreSession()
        const mode = await this.database.callDatabase('readSetting', { key: 'mode' }) || 'unset'
        const shouldPromptLogin = mode === 'unset' && session.status === 'guest'
        let cloudSync = null
        if (session.status === 'authenticated' && session.accountId) {
          try {
            const restored = await this.cloudService.restoreSession(session)
            cloudSync = restored.cloudSync || null
          } catch (_) {
            cloudSync = await this.database.callDatabase('readCloudSyncState', { accountId: session.accountId })
          }
        }
        return {
          session,
          mode,
          shouldPromptLogin,
          cloudSync
        }
      }

      case 'session.beginLogin':
        return this.sessionManager.beginLogin(payload)

      case 'session.getLoginTask':
        return this.sessionManager.getLoginTask(payload)

      case 'session.cancelLogin':
        return this.sessionManager.cancelLogin(payload)

      case 'session.restore':
        return this.sessionManager.restoreSession()

      case 'session.logout':
        return this.sessionManager.logout()

      case 'account.readSnapshot':
        return this.database.callDatabase('readAccountSnapshot', { accountId: context.accountId })

      case 'account.sync':
        return this.accountSyncService.start(context, payload.collections || ['profile', 'repos', 'stars'], payload.force)

      case 'tasks.read':
        return this.accountSyncService.getTask(payload.taskId)

      case 'tasks.cancel':
        return { cancelled: this.accountSyncService.cancelTask(payload.taskId) }

      case 'repositories.list':
        return this.database.callDatabase('listRepositories', {
          accountId: context.accountId,
          kind: payload.kind || 'repos',
          offset: payload.offset || 0,
          limit: payload.limit || 30
        })

      case 'stars.readState':
        return this.starService.readState(context, payload)

      case 'stars.set': {
        const res = await this.starService.set(context, payload.repository, payload.desiredStarred, payload.intentId || `star_${Date.now()}`)
        this.cloudService.syncCollections(context, ['stars']).catch(() => {})
        return res
      }

      case 'history.record': {
        const pref = await this.database.callDatabase('readAccountSnapshot', { accountId: context.accountId })
        if (!pref.preferences?.historyEnabled) {
          return { saved: false, reason: 'history_disabled' }
        }
        const item = await this.database.callDatabase('recordBrowse', {
          accountId: context.accountId,
          repository: payload.repository,
          source: payload.source || 'app',
          viewedAt: payload.viewedAt || Date.now()
        })
        if (item.countedVisit) {
          this.cloudService.flushOutbox(context).catch(() => {})
        }
        return { saved: true, item }
      }

      case 'history.list':
        return this.database.callDatabase('listHistory', {
          accountId: context.accountId,
          cursor: payload.cursor || null,
          limit: payload.limit || 30,
          keyword: payload.keyword || ''
        })

      case 'history.delete':
        await this.database.callDatabase('deleteHistory', { accountId: context.accountId, repoId: payload.repoId })
        this.cloudService.flushOutbox(context).catch(() => {})
        return { deleted: true }

      case 'history.clear':
        await this.database.callDatabase('clearHistory', { accountId: context.accountId })
        this.cloudService.flushOutbox(context).catch(() => {})
        return { cleared: true }

      case 'account.savePreferences':
        return this.cloudService.savePreferences(context, payload)

      case 'account.forgetLocalData':
        await this.cloudService.logoutSession(context).catch(() => {})
        return this.sessionManager.forgetCurrentAccount()

      case 'discovery.refresh':
        return this.handleDiscoveryRefresh(context, payload)

      case 'discovery.read': {
        const cached = await this.database.callDatabase('readFeed', { key: payload.key || 'feed:trending' })
        return cached || { items: [], fetchedAt: null }
      }

      case 'recommendation.createSnapshot':
        return this.database.callDatabase('createSnapshot', {
          accountId: context.accountId,
          purpose: payload.purpose || 'ranking',
          reason: payload.reason || 'user_request'
        })

      case 'recommendation.commit':
        return this.database.callDatabase('commitRecommendation', {
          accountId: context.accountId,
          inputId: payload.inputId,
          inputVersions: payload.inputVersions,
          purpose: payload.purpose,
          profile: payload.profile,
          batch: payload.batch
        })

      case 'recommendation.list':
        return this.database.callDatabase('listRecommendation', {
          accountId: context.accountId,
          batchId: payload.batchId || null,
          offset: payload.offset || 0,
          limit: payload.limit || 20
        })

      case 'recommendation.feedback':
        await this.database.callDatabase('recordRecommendationFeedback', {
          accountId: context.accountId,
          repoId: payload.repoId,
          kind: payload.kind,
          eventId: payload.eventId || `fb_${Date.now()}`
        })
        return { recorded: true }

      case 'repository.open': {
        const repo = payload.repository
        if (repo?.htmlUrl) {
          if (payload.target === 'external') {
            await shell.openExternal(repo.htmlUrl)
          }
        }
        let historySaved = false
        if (context.status === 'authenticated') {
          const pref = await this.database.callDatabase('readAccountSnapshot', { accountId: context.accountId })
          if (pref.preferences?.historyEnabled) {
            const item = await this.database.callDatabase('recordBrowse', {
              accountId: context.accountId,
              repository: repo,
              source: payload.source || 'open',
              viewedAt: Date.now()
            })
            historySaved = true
            if (item.countedVisit) {
              this.cloudService.flushOutbox(context).catch(() => {})
            }
          }
        }
        return { opened: true, historySaved }
      }

      case 'cloud.auth.begin':
        return this.cloudService.beginAuth(context, payload)

      case 'cloud.auth.poll':
        return this.cloudService.pollAuth(context, payload)

      case 'cloud.auth.cancel':
        return this.cloudService.cancelAuth(payload)

      case 'cloud.session.restore':
        return this.cloudService.restoreSession(context)

      case 'cloud.session.logout':
        return this.cloudService.logoutSession(context)

      case 'cloud.sync.readState':
        return this.database.callDatabase('readCloudSyncState', { accountId: context.accountId })

      case 'cloud.sync.flush':
        return this.cloudService.flushOutbox(context)

      case 'cloud.preferences.save':
        return this.cloudService.savePreferences(context, payload)

      case 'cloud.analysis.reset':
        return this.cloudService.resetAnalysis(context)

      case 'cloud.collections.sync':
        return this.cloudService.syncCollections(context, payload.collections || ['stars', 'owned'])

      default:
        throw new Error(`UNKNOWN_OPERATION: ${operation}`)
    }
  }

  async handleDiscoveryRefresh(context, payload) {
    const mode = payload.mode || 'trending'

    if (mode === 'trending') {
      const result = await this.scheduler.enqueue({
        taskId: `disc_trending_${Date.now()}`,
        contextId: context.contextId,
        kind: 'trending',
        taskFn: async () => {
          const workPage = this.browser.getOrCreateWorkPage()
          const executor = this.pageExecutorFactory(workPage.webContents)
          return executor.runTask({
            scriptId: 'readTrendingResults',
            url: this.routes.trendingUrl()
          })
        }
      })

      const items = result?.items || []
      await this.database.callDatabase('saveFeed', {
        key: 'feed:trending',
        items,
        fetchedAt: Date.now()
      })
      return { items, count: items.length }
    }

    if (mode === 'personalized') {
      const rawPlan = payload.queryPlan
      const queryPlan = Array.isArray(rawPlan)
        ? rawPlan
        : (Array.isArray(rawPlan?.queryPlan) ? rawPlan.queryPlan : [])
      const candidates = []

      for (const q of queryPlan.slice(0, 4)) {
        const queryStr = q.query || (q.topics || []).map(t => `topic:${t}`).join(' ')
        const sort = q.sort || 'stars'
        const url = this.routes.searchRepositoriesUrl(queryStr, sort)

        try {
          const searchRes = await this.scheduler.enqueue({
            taskId: `disc_search_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            contextId: context.contextId,
            kind: 'discovery',
            taskFn: async () => {
              const workPage = this.browser.getOrCreateWorkPage()
              const executor = this.pageExecutorFactory(workPage.webContents)
              return executor.runTask({
                scriptId: 'readSearchResults',
                url
              })
            }
          })

          const items = searchRes?.items || []
          candidates.push(...items)

          await this.database.callDatabase('saveDiscoveryCache', {
            accountId: context.accountId,
            queryKey: `search:${queryStr}:${sort}`,
            queryJson: JSON.stringify(q),
            resultJson: JSON.stringify(items),
            fetchedAt: Date.now(),
            expiresAt: Date.now() + 24 * 60 * 60 * 1000
          })
        } catch (err) {
          console.warn('[IpcRouter] 候选查询异常:', err.message)
        }
      }

      return { candidates, count: candidates.length }
    }

    return { items: [], count: 0 }
  }
}

module.exports = {
  IpcRouter
}

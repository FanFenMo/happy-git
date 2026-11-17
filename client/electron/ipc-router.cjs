/**
 * client/electron/ipc-router.cjs
 * 安全 NativeBridge IPC 路由与操作分发 (依据 project.md 第四节及阶段二云端协同契约)
 */

let shell = null
try {
  shell = require('electron').shell || null
} catch (_) {}
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
      'recommendation.listHidden',
      'cloud.auth.begin', 'cloud.auth.poll', 'cloud.session.restore', 'cloud.session.logout',
      'cloud.sync.readState', 'cloud.sync.flush', 'cloud.preferences.save',
      'cloud.analysis.reset', 'cloud.collections.sync',
      'cloud.portrait.read', 'cloud.portrait.refresh', 'cloud.searchPlan.read'
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

      case 'recommendation.feedback': {
        const fbResult = await this.database.callDatabase('recordRecommendationFeedback', {
          accountId: context.accountId,
          repoId: payload.repoId,
          kind: payload.kind,
          hidden: typeof payload.hidden === 'boolean' ? payload.hidden : undefined,
          eventId: payload.eventId || `fb_${Date.now()}`
        })
        this.cloudService.syncFeedbackPreferences(context, {
          operationId: fbResult?.eventId || payload.eventId
        }).catch(() => {})
        return fbResult || { recorded: true }
      }

      case 'recommendation.listHidden':
        return this.database.callDatabase('listHiddenRecommendations', {
          accountId: context.accountId
        })

      case 'repository.open': {
        const repo = payload.repository
        if (repo?.htmlUrl && shell) {
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

      case 'cloud.portrait.read':
        return this.cloudService.readPortrait(context)

      case 'cloud.portrait.refresh':
        return this.cloudService.refreshPortrait(context)

      case 'cloud.searchPlan.read': {
        const portrait = await this.cloudService.readPortrait(context)
        return {
          status: portrait?.status || 'unbound',
          generationId: portrait?.generationId || null,
          modelVersion: portrait?.modelVersion || null,
          searchPlan: portrait?.searchPlan || null
        }
      }

      case 'cloud.cohorts.read':
        return this.cloudService.readCohorts()

      case 'cloud.cohorts.refresh':
        return this.cloudService.refreshCohorts(context)

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
      // 有界搜索：单轮最多 4 个查询、总计最多 8 页；结果按 repoId/canonicalKey 去重并保留完整 DTO
      const MAX_QUERIES = 4
      const MAX_TOTAL_PAGES = 8
      const seen = new Set()
      const candidates = []
      const queryReports = []
      let pagesUsed = 0

      for (const q of queryPlan.slice(0, MAX_QUERIES)) {
        const queryStr = q.query || (q.topics || []).map(t => `topic:${t}`).join(' ')
        if (!queryStr) continue
        const sort = q.sort === 'updated' ? 'updated' : 'stars'
        const startPage = Math.max(1, Number(q.startPage || 1))
        const maxPages = Math.max(1, Math.min(2, Number(q.maxPages || 1)))
        const report = { id: q.id || null, query: queryStr, sort, startPage, pagesFetched: 0, itemCount: 0, nextPage: null, exhausted: false, error: null }

        for (let page = startPage; page < startPage + maxPages && pagesUsed < MAX_TOTAL_PAGES; page++) {
          const url = this.routes.searchRepositoriesUrl(queryStr, sort, page)
          try {
            const searchRes = await this.scheduler.enqueue({
              taskId: `disc_search_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              contextId: context.contextId,
              kind: 'discovery',
              taskFn: async () => {
                const workPage = this.browser.getOrCreateWorkPage()
                const executor = this.pageExecutorFactory(workPage.webContents)
                return executor.runTask({ scriptId: 'readSearchResults', url, args: { pageSeq: page } })
              }
            })
            pagesUsed += 1
            report.pagesFetched += 1
            const items = (searchRes?.items || []).filter(Boolean).map(item => ({
              ...item,
              discoveredBy: { queryId: q.id || null, directionId: q.directionId || null, generationId: q.generationId || null, page }
            }))
            const fresh = []
            for (const item of items) {
              const key = item.repoId || item.canonicalKey
              if (!key || seen.has(key)) continue
              seen.add(key)
              fresh.push(item)
            }
            candidates.push(...fresh)
            report.itemCount += fresh.length
            report.nextPage = searchRes?.nextUrl ? page + 1 : null

            await this.database.callDatabase('saveDiscoveryCache', {
              accountId: context.accountId,
              queryKey: `search:${queryStr}:${sort}:p${page}`,
              queryJson: JSON.stringify({ ...q, page }),
              resultJson: JSON.stringify(items),
              fetchedAt: Date.now(),
              expiresAt: Date.now() + 24 * 60 * 60 * 1000
            })
            if (!searchRes?.nextUrl) {
              report.exhausted = true
              break
            }
          } catch (err) {
            report.error = err.code || err.message
            console.warn('[IpcRouter] 候选查询异常:', err.message)
            if (err.code === 'RATE_LIMITED') pagesUsed = MAX_TOTAL_PAGES
            break
          }
        }
        queryReports.push(report)
      }

      return {
        candidates,
        count: candidates.length,
        pagesUsed,
        bounded: true,
        complete: false,
        queries: queryReports
      }
    }

    return { items: [], count: 0 }
  }
}

module.exports = {
  IpcRouter
}

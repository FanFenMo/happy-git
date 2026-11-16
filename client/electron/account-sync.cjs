/**
 * client/electron/account-sync.cjs
 * 账号公开资料与集合分页同步服务 (依据 project.md 第七节)
 */

class AccountSyncService {
  constructor({ database, browser, scheduler, pageExecutorFactory, routes, cloudService = null }) {
    this.database = database
    this.browser = browser
    this.scheduler = scheduler
    this.pageExecutorFactory = pageExecutorFactory
    this.routes = routes
    this.cloudService = cloudService

    this.activeTasks = new Map() // taskId -> { stage, scannedCount, acceptedCount, skippedPrivateCount, pageSeq, isEnded, error }
  }

  getTask(taskId) {
    return this.activeTasks.get(taskId) || null
  }

  cancelTask(taskId) {
    const task = this.activeTasks.get(taskId)
    if (task) {
      task.isEnded = true
      task.error = { code: 'TASK_CANCELLED', message: '同步任务已取消' }
      this.scheduler.cancelTask(taskId)
      return true
    }
    return false
  }

  async start(context, collections = ['profile', 'repos', 'stars'], force = false) {
    const taskId = 'sync_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
    const taskRecord = {
      taskId,
      stage: 'starting',
      scannedCount: 0,
      acceptedCount: 0,
      skippedPrivateCount: 0,
      pageSeq: 0,
      isEnded: false,
      error: null
    }
    this.activeTasks.set(taskId, taskRecord)

    // 在后台运行同步任务
    setImmediate(async () => {
      try {
        if (collections.includes('profile')) {
          taskRecord.stage = 'syncing_profile'
          await this.syncProfile(context, taskId)
        }

        if (collections.includes('repos') && !taskRecord.isEnded) {
          taskRecord.stage = 'syncing_repos'
          await this.syncCollection(context, 'repos', taskId)
        }

        if (collections.includes('stars') && !taskRecord.isEnded) {
          taskRecord.stage = 'syncing_stars'
          await this.syncCollection(context, 'stars', taskId)
        }

        taskRecord.stage = 'finished'
        taskRecord.isEnded = true
      } catch (err) {
        taskRecord.isEnded = true
        taskRecord.stage = 'failed'
        taskRecord.error = { code: err.code || 'SYNC_FAILED', message: err.message }
      }
    })

    return { taskId }
  }

  async syncProfile(context, taskId) {
    const task = this.activeTasks.get(taskId)
    if (task?.isEnded) return

    return this.scheduler.enqueue({
      taskId: `${taskId}_profile`,
      contextId: context.contextId,
      kind: 'sync',
      taskFn: async () => {
        const workPage = this.browser.getOrCreateWorkPage()
        const executor = this.pageExecutorFactory(workPage.webContents)

        const url = this.routes.profileUrl(context.login)
        const profile = await executor.runTask({
          scriptId: 'readProfile',
          url,
          args: { expectedLogin: context.login }
        })

        if (profile) {
          await this.database.callDatabase('saveProfile', {
            accountId: context.accountId,
            profile: { ...profile, accountId: context.accountId }
          })
        }
      }
    })
  }

  async syncCollection(context, kind, taskId) {
    const task = this.activeTasks.get(taskId)
    if (task?.isEnded) return

    const { generationId } = await this.database.callDatabase('beginSync', {
      accountId: context.accountId,
      kind
    })

    let currentUrl = kind === 'repos'
      ? this.routes.ownedRepositoriesUrl(context.login)
      : this.routes.starredRepositoriesUrl(context.login)

    let pageSeq = 1
    const visitedUrls = new Set()

    try {
      while (currentUrl && !task?.isEnded) {
        if (visitedUrls.has(currentUrl)) {
          const err = new Error('PAGINATION_STALLED: 检测到循环翻页 URL')
          err.code = 'PAGINATION_STALLED'
          throw err
        }
        visitedUrls.add(currentUrl)

        const urlToFetch = currentUrl
        const seqToFetch = pageSeq

        const pageResult = await this.scheduler.enqueue({
          taskId: `${taskId}_${kind}_p${seqToFetch}`,
          contextId: context.contextId,
          kind: 'sync',
          taskFn: async () => {
            const workPage = this.browser.getOrCreateWorkPage()
            const executor = this.pageExecutorFactory(workPage.webContents)

            return executor.runTask({
              scriptId: kind === 'repos' ? 'readOwnedRepositories' : 'readStarredRepositories',
              url: urlToFetch,
              args: { expectedLogin: context.login, pageSeq: seqToFetch }
            })
          }
        })

        if (!pageResult || task?.isEnded) break

        const items = pageResult.items || []
        task.scannedCount += items.length
        task.acceptedCount += items.length
        task.pageSeq = seqToFetch

        const nextUrl = pageResult.nextUrl ? this.routes.validateNextUrl({ kind, login: context.login }, pageResult.nextUrl) : null

        await this.database.callDatabase('writeSyncPage', {
          accountId: context.accountId,
          kind,
          generationId,
          pageSeq: seqToFetch,
          items,
          nextUrl
        })

        if (pageResult.completion === 'end' || !nextUrl) {
          await this.database.callDatabase('finishSync', {
            accountId: context.accountId,
            kind,
            generationId
          })

          // 当本地集合完整收敛后，按完整性与版本号向云端同步集合快照（绝不将 Star 转为浏览事件）
          if (this.cloudService) {
            const cloudCollectionKind = kind === 'repos' ? 'owned' : 'stars'
            this.cloudService.syncCollections(context, [cloudCollectionKind]).catch(() => {})
          }
          break
        }

        currentUrl = nextUrl
        pageSeq++
      }
    } catch (err) {
      console.warn(`[AccountSyncService] 同步 ${kind} 中断:`, err.message)
      await this.database.callDatabase('abortSync', {
        accountId: context.accountId,
        kind,
        generationId,
        errorCode: err.code || 'SYNC_ERROR'
      })
      throw err
    }
  }
}

module.exports = {
  AccountSyncService
}

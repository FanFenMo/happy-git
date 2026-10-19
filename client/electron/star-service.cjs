/**
 * client/electron/star-service.cjs
 * 网页 Star 确定状态操作服务 (依据 project.md 第七节)
 * - withPageLease 独占工作页
 * - 操作前状态核对 (相等则 unchanged)
 * - 原生按钮点击与重载复核确认
 * - 落盘与 uncertain 状态防护
 */

class StarService {
  constructor({ database, browser, scheduler, pageExecutorFactory, routes }) {
    this.database = database
    this.browser = browser
    this.scheduler = scheduler
    this.pageExecutorFactory = pageExecutorFactory
    this.routes = routes
  }

  async readState(context, { repoId, fullName }) {
    return this.database.callDatabase('readStarState', {
      accountId: context.accountId,
      repoId,
      fullName
    })
  }

  async set(context, repository, desiredStarred, intentId) {
    if (!context || context.status !== 'authenticated') {
      const err = new Error('AUTH_REQUIRED: 请先登录 GitHub')
      err.code = 'AUTH_REQUIRED'
      throw err
    }

    const repoKey = repository.repoId || repository.canonicalKey
    const operationId = 'op_' + intentId

    // 检查并保存本地任务记录
    await this.database.callDatabase('saveWebsiteOperation', {
      operation: {
        operationId,
        accountId: context.accountId,
        repoId: repoKey,
        intentId,
        desiredStarred: Boolean(desiredStarred),
        state: 'created',
        attemptedAt: null,
        confirmedAt: null,
        errorCode: null
      }
    })

    return this.scheduler.withPageLease(context, 'star', async () => {
      const workPage = this.browser.getOrCreateWorkPage()
      const executor = this.pageExecutorFactory(workPage.webContents)

      // 1. 导航至目标仓库页
      const repoUrl = this.routes.repositoryUrl(repository.fullName)
      await executor.navigate(repoUrl, 25000)

      // 2. 若缺少数字 ID，先补齐
      let effectiveRepo = { ...repository }
      if (!effectiveRepo.repoId) {
        const detail = await executor.runTask({ scriptId: 'readRepositoryDetail', args: { expectedFullName: repository.fullName } })
        if (detail?.repoId) {
          effectiveRepo = { ...effectiveRepo, ...detail }
        }
      }

      // 3. 读取操作前状态
      const before = await executor.executeScript('readRepositoryStarState')
      if (before && before.starred === desiredStarred) {
        await this.database.callDatabase('updateWebsiteOperation', {
          operationId,
          state: 'unchanged',
          attemptedAt: null,
          confirmedAt: Date.now(),
          errorCode: null
        })
        await this.database.callDatabase('applyConfirmedStar', {
          accountId: context.accountId,
          repository: effectiveRepo,
          starred: desiredStarred
        })
        return {
          state: 'unchanged',
          starred: desiredStarred,
          confirmed: true,
          localCacheSaved: true
        }
      }

      // 4. 标记 attempted (已尝试点击)
      const now = Date.now()
      await this.database.callDatabase('updateWebsiteOperation', {
        operationId,
        state: 'attempted',
        attemptedAt: now,
        confirmedAt: null,
        errorCode: null
      })

      // 5. 点击操作
      const clickRes = await executor.executeScript('setRepositoryStar', { desiredStarred })
      if (!clickRes?.clicked) {
        await this.database.callDatabase('updateWebsiteOperation', {
          operationId,
          state: 'failed',
          attemptedAt: now,
          confirmedAt: null,
          errorCode: 'BUTTON_NOT_FOUND'
        })
        return {
          state: 'uncertain',
          starred: before?.starred ?? null,
          confirmed: false,
          error: '未能定位到目标 Star 按钮'
        }
      }

      // 6. 等待并重新加载同一仓库页面复核
      await new Promise(r => setTimeout(r, 800))
      await executor.reload(25000)

      // 7. 读取最终真实状态
      const after = await executor.executeScript('readRepositoryStarState')
      if (after && after.starred === desiredStarred) {
        const confirmedTime = Date.now()
        await this.database.callDatabase('updateWebsiteOperation', {
          operationId,
          state: 'confirmed',
          attemptedAt: now,
          confirmedAt: confirmedTime,
          errorCode: null
        })

        let localCacheSaved = true
        try {
          await this.database.callDatabase('applyConfirmedStar', {
            accountId: context.accountId,
            repository: effectiveRepo,
            starred: desiredStarred
          })
        } catch (dbErr) {
          console.warn('[StarService] 本地缓存提交失败:', dbErr.message)
          localCacheSaved = false
        }

        return {
          state: 'confirmed',
          starred: desiredStarred,
          confirmed: true,
          localCacheSaved
        }
      } else {
        await this.database.callDatabase('updateWebsiteOperation', {
          operationId,
          state: 'uncertain',
          attemptedAt: now,
          confirmedAt: null,
          errorCode: 'STAR_STATE_UNCERTAIN'
        })

        return {
          state: 'uncertain',
          starred: after?.starred ?? null,
          confirmed: false,
          error: '远端状态核对未确认'
        }
      }
    })
  }
}

module.exports = {
  StarService
}

/**
 * client/electron/task-scheduler.cjs
 * 后台工作页页面任务串行调度器 (依据 project.md 第六节)
 * - 优先级调度 (Star > 登录/复核 > 候选发现 > 后台集合同步)
 * - withPageLease 独占工作页租约机制
 * - 导航节流 (默认 1.5s) 与频次限制降级 (60s/300s)
 */

class PageTaskScheduler {
  constructor() {
    this.queue = [] // { id, priority, contextId, taskFn, resolve, reject, cancelled: false }
    this.currentTask = null
    this.isLeased = false
    this.leaseHolder = null
    this.lastNavigationTime = 0
    this.minIntervalMs = 1500
    this.rateLimitedUntil = 0
    this.consecutiveRateLimits = 0
    this.leaseQueue = []
  }

  // 优先级定义: star: 1, verify: 2, discovery: 3, sync: 4
  static getPriority(kind) {
    switch (kind) {
      case 'star': return 1
      case 'verify':
      case 'identity': return 2
      case 'discovery':
      case 'search':
      case 'trending': return 3
      case 'sync': return 4
      default: return 5
    }
  }

  /**
   * 独占工作页执行一系列页面操作
   */
  async withPageLease(context, purpose, workFn) {
    const priority = PageTaskScheduler.getPriority(purpose)

    return new Promise((resolve, reject) => {
      this.leaseQueue.push({
        priority,
        contextId: context.contextId,
        purpose,
        workFn,
        resolve,
        reject
      })
      this.leaseQueue.sort((a, b) => a.priority - b.priority)
      this.processLeaseQueue()
    })
  }

  async processLeaseQueue() {
    if (this.isLeased || this.leaseQueue.length === 0) return

    const item = this.leaseQueue.shift()
    this.isLeased = true
    this.leaseHolder = item.purpose

    try {
      await this.enforceThrottling()
      const result = await item.workFn()
      item.resolve(result)
    } catch (err) {
      if (err?.code === 'RATE_LIMITED') {
        this.handleRateLimit()
      }
      item.reject(err)
    } finally {
      this.isLeased = false
      this.leaseHolder = null
      this.lastNavigationTime = Date.now()
      setImmediate(() => this.processLeaseQueue())
    }
  }

  /**
   * 普通后台任务排队入队
   */
  enqueue(task) {
    const priority = PageTaskScheduler.getPriority(task.kind)
    return new Promise((resolve, reject) => {
      const entry = {
        id: task.taskId,
        priority,
        contextId: task.contextId,
        kind: task.kind,
        taskFn: task.taskFn,
        resolve,
        reject,
        cancelled: false
      }
      this.queue.push(entry)
      this.queue.sort((a, b) => a.priority - b.priority)
      this.processQueue()
    })
  }

  async processQueue() {
    if (this.isLeased || this.currentTask || this.queue.length === 0) return

    const entry = this.queue.shift()
    if (entry.cancelled) {
      entry.reject(new Error('TASK_CANCELLED'))
      return this.processQueue()
    }

    this.currentTask = entry
    try {
      await this.enforceThrottling()
      const result = await entry.taskFn()
      entry.resolve(result)
    } catch (err) {
      if (err?.code === 'RATE_LIMITED') {
        this.handleRateLimit()
      }
      entry.reject(err)
    } finally {
      this.currentTask = null
      this.lastNavigationTime = Date.now()
      setImmediate(() => this.processQueue())
    }
  }

  async enforceThrottling() {
    const now = Date.now()
    if (this.rateLimitedUntil > now) {
      const waitMs = this.rateLimitedUntil - now
      await new Promise(r => setTimeout(r, waitMs))
    }

    const elapsed = Date.now() - this.lastNavigationTime
    if (elapsed < this.minIntervalMs) {
      await new Promise(r => setTimeout(r, this.minIntervalMs - elapsed))
    }
  }

  handleRateLimit() {
    this.consecutiveRateLimits++
    const cooldownMs = this.consecutiveRateLimits > 1 ? 5 * 60 * 1000 : 60 * 1000
    this.rateLimitedUntil = Date.now() + cooldownMs
    console.warn(`[PageTaskScheduler] GitHub 触发频率限制，冷却 ${cooldownMs / 1000} 秒`)
  }

  cancelTask(taskId) {
    const inQueue = this.queue.find(t => t.id === taskId)
    if (inQueue) {
      inQueue.cancelled = true
      return true
    }
    return false
  }

  cancelAllForContext(contextId) {
    for (const item of this.queue) {
      if (item.contextId === contextId) {
        item.cancelled = true
      }
    }
    for (let i = this.leaseQueue.length - 1; i >= 0; i--) {
      if (this.leaseQueue[i].contextId === contextId) {
        const item = this.leaseQueue.splice(i, 1)[0]
        item.reject(new Error('CONTEXT_INVALIDATED'))
      }
    }
  }
}

module.exports = {
  PageTaskScheduler
}

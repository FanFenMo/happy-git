/**
 * client/electron/page-executor.cjs
 * 后台 GitHub 页面任务执行器 (依据 project.md 第六节)
 * - 调度导航与有限超时 (默认 30s)
 * - 页面类型识别 (detectPage) 与语义结构探针 (每 250ms 复核，最多 10s)
 * - 执行固定安装包脚本与 DTO 严格规范化
 */

const { rawSources, parserVersion } = require('./generated/page-scripts.cjs')

let normalizeModule = null
async function getNormalize() {
  if (!normalizeModule) {
    normalizeModule = await import('../shared/github-page/normalize.js')
  }
  return normalizeModule
}

class PageExecutor {
  constructor(webContents) {
    this.webContents = webContents
  }

  /**
   * 导航至指定 URL，带有限超时
   */
  async navigate(url, timeoutMs = 30000) {
    if (!this.webContents || this.webContents.isDestroyed()) {
      throw new Error('PAGE_DESTROYED')
    }

    return new Promise((resolve, reject) => {
      let timer = null
      let done = false

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        this.webContents.removeListener('did-finish-load', onLoad)
        this.webContents.removeListener('did-fail-load', onFail)
      }

      const onLoad = () => {
        if (done) return
        done = true
        cleanup()
        resolve()
      }

      const onFail = (_event, errorCode, errorDescription) => {
        if (done) return
        done = true
        cleanup()
        if (errorCode === -3) { // ABORTED (e.g. redirected or new navigation started)
          resolve()
        } else {
          const err = new Error(`LOAD_FAILED: ${errorDescription} (${errorCode})`)
          err.code = 'NETWORK_UNAVAILABLE'
          reject(err)
        }
      }

      timer = setTimeout(() => {
        if (done) return
        done = true
        cleanup()
        this.webContents.stop()
        const err = new Error('PAGE_TIMEOUT: 页面导航超时')
        err.code = 'PAGE_TIMEOUT'
        reject(err)
      }, timeoutMs)

      this.webContents.once('did-finish-load', onLoad)
      this.webContents.once('did-fail-load', onFail)

      this.webContents.loadURL(url).catch(err => {
        if (done) return
        done = true
        cleanup()
        err.code = 'NETWORK_UNAVAILABLE'
        reject(err)
      })
    })
  }

  /**
   * 重新加载当前页面
   */
  async reload(timeoutMs = 30000) {
    if (!this.webContents || this.webContents.isDestroyed()) {
      throw new Error('PAGE_DESTROYED')
    }

    return new Promise((resolve, reject) => {
      let timer = null
      let done = false

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        this.webContents.removeListener('did-finish-load', onLoad)
        this.webContents.removeListener('did-fail-load', onFail)
      }

      const onLoad = () => {
        if (done) return
        done = true
        cleanup()
        resolve()
      }

      const onFail = (_event, errorCode, errorDescription) => {
        if (done) return
        done = true
        cleanup()
        const err = new Error(`RELOAD_FAILED: ${errorDescription} (${errorCode})`)
        err.code = 'NETWORK_UNAVAILABLE'
        reject(err)
      }

      timer = setTimeout(() => {
        if (done) return
        done = true
        cleanup()
        this.webContents.stop()
        const err = new Error('PAGE_TIMEOUT: 页面刷新超时')
        err.code = 'PAGE_TIMEOUT'
        reject(err)
      }, timeoutMs)

      this.webContents.once('did-finish-load', onLoad)
      this.webContents.once('did-fail-load', onFail)

      this.webContents.reload()
    })
  }

  /**
   * 等待页面语义结构就绪 (每 250ms 轮询探针，最多 timeoutMs)
   */
  async waitForStructure(targetKind = null, timeoutMs = 10000, pollIntervalMs = 250) {
    const startTime = Date.now()

    while (Date.now() - startTime < timeoutMs) {
      if (!this.webContents || this.webContents.isDestroyed()) {
        throw new Error('PAGE_DESTROYED')
      }

      const pageInfo = await this.executeScript('detectPage')
      if (pageInfo?.pageKind === 'rate_limit') {
        const err = new Error('RATE_LIMITED')
        err.code = 'RATE_LIMITED'
        throw err
      }

      if (pageInfo?.hasStructure) {
        if (!targetKind || pageInfo.pageKind === targetKind) {
          return pageInfo
        }
      }

      await new Promise(r => setTimeout(r, pollIntervalMs))
    }

    // 超时仍未检测到所需结构
    const finalInfo = await this.executeScript('detectPage')
    if (finalInfo?.pageKind === 'rate_limit') {
      const err = new Error('RATE_LIMITED')
      err.code = 'RATE_LIMITED'
      throw err
    }
    return finalInfo
  }

  /**
   * 在页面执行固定脚本并取回原始数据
   */
  async executeScript(scriptId, args = {}) {
    if (!this.webContents || this.webContents.isDestroyed()) {
      throw new Error('PAGE_DESTROYED')
    }

    const rawCode = rawSources[scriptId]
    if (!rawCode) {
      throw new Error(`UNKNOWN_PAGE_SCRIPT: ${scriptId}`)
    }

    const cleanFn = rawCode.replace(/^export\s+function\s+run/m, 'function run')
    const iife = `(() => {
      try {
        ${cleanFn}
        return run(document, ${JSON.stringify(args || {})});
      } catch (e) {
        return { __script_error__: e.message || String(e) };
      }
    })()`

    const result = await this.webContents.executeJavaScript(iife, true)
    if (result && result.__script_error__) {
      console.warn(`[PageExecutor] 脚本 ${scriptId} 执行报错:`, result.__script_error__)
    }
    return result
  }

  /**
   * 运行特定提取任务并进行 DTO 规范化校验
   */
  async runTask({ scriptId, url = null, args = {}, expectedPageKind = null }) {
    if (url) {
      await this.navigate(url)
    }

    // 等待语义结构
    const pageInfo = await this.waitForStructure(expectedPageKind)

    // 检查页面契约是否损坏或遇到限制
    if (pageInfo?.pageKind === 'rate_limit') {
      const err = new Error('RATE_LIMITED')
      err.code = 'RATE_LIMITED'
      throw err
    }

    const rawData = await this.executeScript(scriptId, args)
    const { normalizeProfile, normalizeRepository } = await getNormalize()
    const now = Date.now()

    if (scriptId === 'readProfile') {
      return normalizeProfile(rawData, now)
    }

    if (scriptId === 'readOwnedRepositories' || scriptId === 'readStarredRepositories') {
      const items = (rawData?.items || []).map(r => normalizeRepository(r, scriptId === 'readStarredRepositories' ? 'stars' : 'repositories', now))
      return {
        pageKind: scriptId === 'readStarredRepositories' ? 'stars' : 'repositories',
        items,
        nextUrl: rawData?.nextUrl || null,
        completion: rawData?.completion || 'end',
        pageSeq: rawData?.pageSeq || args.pageSeq || 1,
        parserVersion
      }
    }

    if (scriptId === 'readSearchResults') {
      const items = (rawData?.items || []).map(r => normalizeRepository(r, 'search', now))
      return {
        pageKind: 'search',
        items,
        nextUrl: rawData?.nextUrl || null,
        completion: rawData?.completion || 'end',
        pageSeq: rawData?.pageSeq || args.pageSeq || 1,
        parserVersion
      }
    }

    if (scriptId === 'readTrendingResults') {
      const items = (rawData?.items || []).map(r => normalizeRepository(r, 'trending', now))
      return {
        pageKind: 'trending',
        items,
        nextUrl: null,
        completion: 'end',
        parserVersion
      }
    }

    if (scriptId === 'readRepositoryDetail') {
      return normalizeRepository(rawData, 'detail', now)
    }

    return rawData
  }
}

module.exports = {
  PageExecutor
}

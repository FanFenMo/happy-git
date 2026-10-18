/**
 * main.cjs
 * Electron 主进程：窗口管理、受控 IPC 分发、数据目录与生命周期
 */
const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// 1. 设置稳定的正式数据目录
const userDataPath = path.join(app.getPath('appData'), 'HappyGit')
app.setPath('userData', userDataPath)

const { startDatabaseWorker, callDatabase, closeDatabaseWorker } = require('./database.cjs')
const { requestGitHub } = require('./github.cjs')
const {
  initAuth,
  beginAuthorization,
  pollAuthorization,
  cancelAuthorization,
  ensureAccessToken,
  restoreSession,
  clearCredentials,
  getContextId,
  getCurrentAccountId
} = require('./auth.cjs')

// 读取构建时生成的受控公开配置
let publicConfig = { githubClientId: '', apiBaseUrl: '' }
try {
  const cfgPath = path.join(__dirname, 'config.generated.json')
  if (fs.existsSync(cfgPath)) {
    publicConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
  }
} catch (err) {
  console.warn('[main.cjs] 未找到 config.generated.json:', err.message)
}

let mainWindow = null

function isSafeGitHubUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'github.com' &&
      !parsed.username &&
      !parsed.password
    )
  } catch {
    return false
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 860,
    minWidth: 380,
    minHeight: 600,
    maxWidth: 900,
    title: 'HappyGit - 开源项目个性化推荐与展示系统',
    autoHideMenuBar: true,
    backgroundColor: '#0E1116',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  })

  Menu.setApplicationMenu(null)

  // 拦截 target="_blank" 及外部跳转，确保 GitHub 链接由外部默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeGitHubUrl(url)) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (isSafeGitHubUrl(url)) {
      shell.openExternal(url)
    }
  })

  const indexPath = path.join(__dirname, '../dist/index.html')
  mainWindow.loadFile(indexPath).catch((err) => {
    console.error('[main.cjs] 加载本地页面失败:', err)
  })
}

// 注册受控 IPC 操作分发
function registerIpcHandlers() {
  ipcMain.handle('happyGit:invoke', async (event, { operation, payload = {}, contextId = null }) => {
    // 校验发送者为本应用主窗口的主 frame
    if (event.senderFrame !== mainWindow?.webContents?.mainFrame) {
      return {
        ok: false,
        error: { code: 'FORBIDDEN', message: '非法 IPC 调用来源' }
      }
    }

    try {
      switch (operation) {
        case 'app.initialize': {
          const mode = (await callDatabase('readSetting', { key: 'mode' })) || 'unset'
          const session = await restoreSession(callDatabase)
          const shouldPromptLogin = mode === 'unset' && session.status === 'guest'
          return {
            ok: true,
            data: {
              session,
              mode,
              shouldPromptLogin
            }
          }
        }

        case 'auth.begin': {
          const challenge = await beginAuthorization(publicConfig.githubClientId)
          return { ok: true, data: challenge }
        }

        case 'auth.poll': {
          const progress = await pollAuthorization(payload.challengeId, callDatabase)
          return { ok: true, data: progress }
        }

        case 'auth.cancel': {
          cancelAuthorization(payload.challengeId)
          return { ok: true, data: { cancelled: true } }
        }

        case 'auth.restore': {
          const session = await restoreSession(callDatabase)
          return { ok: true, data: session }
        }

        case 'auth.logout': {
          clearCredentials()
          await callDatabase('saveSetting', { key: 'mode', value: 'guest' })
          await callDatabase('saveSetting', { key: 'active_account_id', value: null })
          return {
            ok: true,
            data: {
              status: 'guest',
              accountId: null,
              contextId: getContextId(),
              profile: null,
              verifiedAt: null
            }
          }
        }

        case 'github.request': {
          let token = null
          // 部分资源需要认证
          if (['currentUser', 'ownedRepos', 'starredRepos', 'starState', 'addStar', 'removeStar'].includes(payload.resource)) {
            token = await ensureAccessToken()
          }
          const resp = await requestGitHub(payload.resource, payload.args || {}, token)
          return { ok: true, data: resp }
        }

        case 'account.saveProfile': {
          const accountId = getCurrentAccountId()
          if (!accountId) throw new Error('AUTH_REQUIRED')
          await callDatabase('saveProfile', { accountId, profile: payload.profile })
          return { ok: true, data: { saved: true } }
        }

        case 'account.readSnapshot': {
          const accountId = getCurrentAccountId()
          if (!accountId) {
            return {
              ok: true,
              data: {
                profile: null,
                preferences: { historyEnabled: false, manualTags: [] },
                repoSync: { status: 'idle', loadedCount: 0, complete: false, lastSyncedAt: null, errorCode: null, retryAt: null },
                starSync: { status: 'idle', loadedCount: 0, complete: false, lastSyncedAt: null, errorCode: null, retryAt: null }
              }
            }
          }
          const snap = await callDatabase('readAccountSnapshot', { accountId })
          return { ok: true, data: snap }
        }

        case 'account.savePreferences': {
          const accountId = getCurrentAccountId()
          if (!accountId) throw new Error('AUTH_REQUIRED')
          await callDatabase('savePreferences', { accountId, preferences: payload })
          return { ok: true, data: { saved: true } }
        }

        case 'account.forgetLocalData': {
          const accountId = getCurrentAccountId()
          if (accountId) {
            await callDatabase('forgetAccount', { accountId })
          }
          clearCredentials()
          await callDatabase('saveSetting', { key: 'mode', value: 'guest' })
          return { ok: true, data: { forgotten: true } }
        }

        case 'sync.begin': {
          const accountId = getCurrentAccountId()
          if (!accountId) throw new Error('AUTH_REQUIRED')
          const res = await callDatabase('beginSync', { accountId, kind: payload.kind })
          return { ok: true, data: res }
        }

        case 'sync.writePage': {
          const accountId = getCurrentAccountId()
          if (!accountId) throw new Error('AUTH_REQUIRED')
          const res = await callDatabase('writeSyncPage', {
            accountId,
            kind: payload.kind,
            generationId: payload.generationId,
            page: payload.page,
            items: payload.items,
            nextPage: payload.nextPage
          })
          return { ok: true, data: res }
        }

        case 'sync.finish': {
          const accountId = getCurrentAccountId()
          if (!accountId) throw new Error('AUTH_REQUIRED')
          const res = await callDatabase('finishSync', {
            accountId,
            kind: payload.kind,
            generationId: payload.generationId
          })
          return { ok: true, data: res }
        }

        case 'sync.abort': {
          const accountId = getCurrentAccountId()
          if (accountId) {
            await callDatabase('abortSync', {
              accountId,
              kind: payload.kind,
              generationId: payload.generationId,
              errorCode: payload.errorCode,
              retryAt: payload.retryAt
            })
          }
          return { ok: true, data: { aborted: true } }
        }

        case 'repositories.list': {
          const accountId = getCurrentAccountId()
          if (!accountId) {
            return { ok: true, data: { items: [], total: null, loadedCount: 0, complete: false, nextOffset: null } }
          }
          const res = await callDatabase('listRepositories', {
            accountId,
            kind: payload.kind,
            offset: payload.offset || 0,
            limit: payload.limit || 30
          })
          return { ok: true, data: res }
        }

        case 'repositories.isStarred': {
          const accountId = getCurrentAccountId()
          if (!accountId) {
            return { ok: true, data: { known: true, starred: false } }
          }
          const res = await callDatabase('isRepositoryStarred', {
            accountId,
            repoId: payload.repoId
          })
          return { ok: true, data: res }
        }

        case 'stars.applyConfirmed': {
          const accountId = getCurrentAccountId()
          if (!accountId) throw new Error('AUTH_REQUIRED')
          await callDatabase('applyConfirmedStar', {
            accountId,
            repository: payload.repository,
            starred: payload.starred
          })
          return { ok: true, data: { applied: true } }
        }

        case 'history.record': {
          const accountId = getCurrentAccountId()
          if (!accountId) {
            return { ok: true, data: null }
          }
          const entry = await callDatabase('recordBrowse', {
            accountId,
            repository: payload.repository,
            source: payload.source || 'trending',
            viewedAt: payload.viewedAt || Date.now()
          })
          return { ok: true, data: entry }
        }

        case 'history.list': {
          const accountId = getCurrentAccountId()
          if (!accountId) {
            return { ok: true, data: { items: [], nextCursor: null, total: 0 } }
          }
          const res = await callDatabase('listHistory', {
            accountId,
            cursor: payload.cursor,
            limit: payload.limit || 30,
            keyword: payload.keyword || ''
          })
          return { ok: true, data: res }
        }

        case 'history.delete': {
          const accountId = getCurrentAccountId()
          if (accountId) {
            await callDatabase('deleteHistory', { accountId, repoId: payload.repoId })
          }
          return { ok: true, data: { deleted: true } }
        }

        case 'history.clear': {
          const accountId = getCurrentAccountId()
          if (accountId) {
            await callDatabase('clearHistory', { accountId })
          }
          return { ok: true, data: { cleared: true } }
        }

        case 'history.count': {
          const accountId = getCurrentAccountId()
          const cnt = accountId ? await callDatabase('countHistory', { accountId }) : 0
          return { ok: true, data: cnt }
        }

        case 'feed.fetchRemote': {
          if (!publicConfig.apiBaseUrl) {
            return { ok: false, error: { code: 'CONFIG_MISSING', message: '未配置后端服务地址' } }
          }
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 8000)
          try {
            const url = `${publicConfig.apiBaseUrl}/api/projects/trending?limit=20`
            const res = await fetch(url, { signal: controller.signal })
            if (!res.ok) {
              return { ok: false, error: { code: 'NETWORK_UNAVAILABLE', message: `后端状态码: ${res.status}` } }
            }
            const data = await res.json()
            return { ok: true, data: data.data || [] }
          } finally {
            clearTimeout(timer)
          }
        }

        case 'feed.read': {
          const res = await callDatabase('readFeed', { key: payload.key })
          return { ok: true, data: res }
        }

        case 'feed.save': {
          await callDatabase('saveFeed', {
            key: payload.key,
            items: payload.items,
            fetchedAt: payload.fetchedAt || Date.now()
          })
          return { ok: true, data: { saved: true } }
        }

        case 'settings.save': {
          if (payload.mode) {
            await callDatabase('saveSetting', { key: 'mode', value: payload.mode })
          }
          return { ok: true, data: { saved: true } }
        }

        case 'external.open': {
          if (!payload.url || !isSafeGitHubUrl(payload.url)) {
            return { ok: false, error: { code: 'INVALID_ARGUMENT', message: '非法链接地址' } }
          }
          await shell.openExternal(payload.url)
          return { ok: true, data: { opened: true } }
        }

        default:
          return {
            ok: false,
            error: { code: 'INVALID_ARGUMENT', message: `未知的操作名: ${operation}` }
          }
      }
    } catch (err) {
      console.error(`[main.cjs] 操作 ${operation} 执行失败:`, err)
      return {
        ok: false,
        error: {
          code: err.message.startsWith('AUTH_') || err.message.startsWith('CONFIG_') ? err.message : 'INTERNAL_ERROR',
          message: err.message || '内部服务处理失败'
        }
      }
    }
  })
}

app.whenReady().then(async () => {
  const dbPath = path.join(userDataPath, 'data/happygit.db')
  await startDatabaseWorker(dbPath)
  initAuth(userDataPath)
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', async () => {
  await closeDatabaseWorker()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

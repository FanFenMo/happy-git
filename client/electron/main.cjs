/**
 * client/electron/main.cjs
 * Electron 主进程：窗口管理、生命周期与受控 NativeBridge 初始化 (依据 project.md 第二节、第五节与第十一节)
 */

const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// 1. 设置稳定的正式数据目录
const userDataPath = path.join(app.getPath('appData'), 'HappyGit')
app.setPath('userData', userDataPath)

const { startDatabaseWorker, callDatabase, closeDatabaseWorker } = require('./database.cjs')
const { GitHubBrowser } = require('./github-browser.cjs')
const { PageExecutor } = require('./page-executor.cjs')
const { PageTaskScheduler } = require('./task-scheduler.cjs')
const { SessionManager } = require('./session-manager.cjs')
const { AccountSyncService } = require('./account-sync.cjs')
const { StarService } = require('./star-service.cjs')
const { IpcRouter } = require('./ipc-router.cjs')

let mainWindow = null
let ipcRouter = null
let sessionManager = null
let githubBrowser = null

function isSafeGitHubUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'github.com' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port
    )
  } catch {
    return false
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 880,
    minWidth: 380,
    minHeight: 600,
    maxWidth: 960,
    title: 'HappyGit - 开源项目个性化推荐与展示系统',
    autoHideMenuBar: true,
    backgroundColor: '#10151D',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  })

  Menu.setApplicationMenu(null)

  // 拦截外链并在系统浏览器中打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeGitHubUrl(url) || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (isSafeGitHubUrl(url) || url.startsWith('https://')) {
      shell.openExternal(url)
    }
  })

  const indexPath = path.join(__dirname, '../dist/index.html')
  mainWindow.loadFile(indexPath).catch((err) => {
    console.error('[main.cjs] 加载本地页面失败:', err)
  })
}

async function initializeApp() {
  const dbPath = path.join(userDataPath, 'happygit.db')
  await startDatabaseWorker(dbPath)

  let routes
  try {
    routes = require('../shared/github-page/routes.js')
  } catch {
    routes = await import('../shared/github-page/routes.js')
  }

  githubBrowser = new GitHubBrowser()
  const scheduler = new PageTaskScheduler()
  const pageExecutorFactory = (webContents) => new PageExecutor(webContents)

  const dbProxy = { callDatabase }

  sessionManager = new SessionManager({
    database: dbProxy,
    browser: githubBrowser,
    scheduler,
    pageExecutorFactory
  })

  const accountSyncService = new AccountSyncService({
    database: dbProxy,
    browser: githubBrowser,
    scheduler,
    pageExecutorFactory,
    routes
  })

  const starService = new StarService({
    database: dbProxy,
    browser: githubBrowser,
    scheduler,
    pageExecutorFactory,
    routes
  })

  ipcRouter = new IpcRouter({
    sessionManager,
    accountSyncService,
    starService,
    database: dbProxy,
    browser: githubBrowser,
    scheduler,
    pageExecutorFactory,
    routes
  })

  ipcMain.handle('happyGit:invoke', async (event, args = {}) => {
    // 校验发起来源必须为主窗口
    if (!mainWindow || (event.sender && event.sender !== mainWindow.webContents)) {
      throw new Error('UNAUTHORIZED_CALLER')
    }
    return ipcRouter.handleInvoke(event, args)
  })

  await sessionManager.initialize()
  createWindow()
}

const readyPromise = app.whenReady()
if (readyPromise && typeof readyPromise.then === 'function') {
  const p = readyPromise.then(initializeApp)
  if (p && typeof p.catch === 'function') {
    p.catch(err => {
      console.error('[main.cjs] 应用启动异常:', err)
    })
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async () => {
  try {
    await closeDatabaseWorker()
  } catch (err) {
    console.warn('[main.cjs] 关闭数据库连接异常:', err.message)
  }
})

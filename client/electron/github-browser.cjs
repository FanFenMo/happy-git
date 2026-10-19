/**
 * client/electron/github-browser.cjs
 * 应用管理的真实 GitHub 网页窗口与后台工作页 (依据 project.md 第五节)
 * - 专用持久 partition: persist:happygit-github
 * - 真实登录窗口 (带安全隔离与原生地址提示)
 * - 单一后台工作页 (复用相同 partition 会话)
 */

const { BrowserWindow, session } = require('electron')

const GITHUB_PARTITION = 'persist:happygit-github'

class GitHubBrowser {
  constructor() {
    this.loginWindow = null
    this.workWindow = null
    this.session = null
  }

  initialize() {
    if (session && typeof session.fromPartition === 'function') {
      this.session = session.fromPartition(GITHUB_PARTITION)
    }
    // 确保安全的网络过滤与 Cookie 持久化
  }

  /**
   * 打开真实的 GitHub 网页登录窗口
   */
  openLoginWindow({ loginTaskId, onStateChange, onIdentityDetected, onClosed }) {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus()
      return this.loginWindow
    }

    onStateChange?.('opening')

    this.loginWindow = new BrowserWindow({
      width: 500,
      height: 720,
      title: 'GitHub 登录 - https://github.com',
      autoHideMenuBar: true,
      webPreferences: {
        partition: GITHUB_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    })

    const webContents = this.loginWindow.webContents

    // 检查页面跳转与登录状态
    const checkIdentity = async () => {
      try {
        const url = webContents.getURL()
        if (!url.startsWith('https://github.com')) return

        // 仅在主 frame 就绪后探针当前身份
        const identityScript = `(() => {
          const metaActorId = document.querySelector('meta[name="octolytics-actor-id"]')?.getAttribute('content');
          const metaActorLogin = document.querySelector('meta[name="octolytics-actor-login"]')?.getAttribute('content');
          const metaUserLogin = document.querySelector('meta[name="user-login"]')?.getAttribute('content');
          const login = (metaActorLogin || metaUserLogin || '').trim();
          const accountId = (metaActorId && metaActorId !== '0') ? metaActorId.trim() : null;
          if (login && login !== 'undefined') {
            return { kind: 'authenticated', accountId, login, evidence: 'meta_tags' };
          }
          const headerUser = document.querySelector('[data-login]')?.getAttribute('data-login')
            || document.querySelector('img.avatar-user')?.getAttribute('alt')?.replace(/^@/, '');
          if (headerUser && headerUser !== 'undefined') {
            return { kind: 'authenticated', accountId, login: headerUser.trim(), evidence: 'header_user' };
          }
          if (document.querySelector('input[name="otp"]') || location.pathname.includes('/two-factor')) {
            return { kind: 'verification', accountId: null, login: null, evidence: '2fa' };
          }
          if (document.querySelector('#login_field')) {
            return { kind: 'anonymous', accountId: null, login: null, evidence: 'login_form' };
          }
          return { kind: 'unknown', accountId: null, login: null, evidence: 'no_markers' };
        })()`

        const identity = await webContents.executeJavaScript(identityScript, true)
        if (identity?.kind === 'verification') {
          onStateChange?.('verifying')
        } else if (identity?.kind === 'authenticated') {
          onStateChange?.('authenticated')
          onIdentityDetected?.(identity)
          // 延迟关闭登录窗口，让用户看到登录成功
          setTimeout(() => {
            if (this.loginWindow && !this.loginWindow.isDestroyed()) {
              this.loginWindow.close()
            }
          }, 600)
        } else {
          onStateChange?.('waiting')
        }
      } catch (err) {
        console.warn('[GitHubBrowser] 登录窗口身份检查异常:', err.message)
      }
    }

    webContents.on('did-finish-load', () => {
      onStateChange?.('waiting')
      checkIdentity()
    })

    this.loginWindow.on('closed', () => {
      this.loginWindow = null
      onClosed?.()
    })

    this.loginWindow.loadURL('https://github.com/login')
    return this.loginWindow
  }

  closeLoginWindow() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.close()
      this.loginWindow = null
    }
  }

  /**
   * 创建或获取复用同 partition 的后台工作页
   */
  getOrCreateWorkPage() {
    if (this.workWindow && !this.workWindow.isDestroyed()) {
      return this.workWindow
    }

    this.workWindow = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: {
        partition: GITHUB_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    })

    return this.workWindow
  }

  async clearSessionData() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.close()
      this.loginWindow = null
    }
    if (this.workWindow && !this.workWindow.isDestroyed()) {
      this.workWindow.close()
      this.workWindow = null
    }
    if (this.session) {
      await this.session.clearStorageData({
        storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage']
      })
    }
  }
}

module.exports = {
  GitHubBrowser,
  GITHUB_PARTITION
}

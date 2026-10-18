/**
 * 统一平台能力入口
 * 优先检查 Electron preload 接口，再检查 Capacitor 原生插件
 */
import { electronAdapter } from './electron'
import { androidAdapter } from './android'

export const nativeBridge = {
  getPlatform() {
    if (electronAdapter.isAvailable()) return 'electron'
    if (androidAdapter.isAvailable()) return 'android'
    return 'web'
  },

  isNative() {
    return electronAdapter.isAvailable() || androidAdapter.isAvailable()
  },

  async invoke(operation, payload = {}, contextId = null) {
    if (electronAdapter.isAvailable()) {
      return await electronAdapter.invoke(operation, payload, contextId)
    }
    if (androidAdapter.isAvailable()) {
      return await androidAdapter.invoke(operation, payload, contextId)
    }

    // 浏览器开发环境兜底（仅供开发时预览公开热门，账号与本地数据库操作返回明确提示）
    console.warn(`[nativeBridge.webFallback] 浏览器环境调用受限原生能力: ${operation}`)
    if (operation === 'app.initialize') {
      return {
        ok: true,
        data: {
          session: {
            status: 'guest',
            accountId: null,
            contextId: 'web-session',
            profile: null,
            verifiedAt: null
          },
          mode: 'guest',
          shouldPromptLogin: false
        }
      }
    }
    if (operation === 'external.open') {
      if (payload.url) {
        window.open(payload.url, '_blank')
        return { ok: true, data: { opened: true } }
      }
    }

    return {
      ok: false,
      error: {
        code: 'PLATFORM_UNAVAILABLE',
        message: '当前运行在普通浏览器环境，GitHub 授权与本地 SQLite 数据库仅在 Windows 桌面端或 Android 客户端中可用。'
      }
    }
  }
}

/**
 * Android (Capacitor) 平台适配器
 * 调用 Capacitor 原生插件 HappyGit.invoke
 */
import { Capacitor } from '@capacitor/core'

export const androidAdapter = {
  isAvailable() {
    return Boolean(
      Capacitor.isNativePlatform() &&
      Capacitor.Plugins &&
      Capacitor.Plugins.HappyGit &&
      typeof Capacitor.Plugins.HappyGit.invoke === 'function'
    )
  },

  async invoke(operation, payload = {}, contextId = null) {
    if (!this.isAvailable()) {
      return {
        ok: false,
        error: { code: 'PLATFORM_UNAVAILABLE', message: 'Android 原生插件接口不可用' }
      }
    }
    try {
      const res = await Capacitor.Plugins.HappyGit.invoke({
        operation,
        payload,
        contextId
      })
      return res
    } catch (err) {
      return {
        ok: false,
        error: { code: 'BRIDGE_ERROR', message: err.message || 'Android 原生桥调用异常' }
      }
    }
  }
}

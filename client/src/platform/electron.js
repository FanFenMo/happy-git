/**
 * Electron 平台适配器
 * 调用 window.happyGit.invoke(operation, payload, contextId)
 */

export const electronAdapter = {
  isAvailable() {
    return Boolean(typeof window !== 'undefined' && window.happyGit && typeof window.happyGit.invoke === 'function')
  },

  async invoke(operation, payload = {}, contextId = null) {
    if (!this.isAvailable()) {
      return {
        ok: false,
        error: { code: 'PLATFORM_UNAVAILABLE', message: 'Electron 原生接口不可用' }
      }
    }
    try {
      return await window.happyGit.invoke(operation, payload, contextId)
    } catch (err) {
      return {
        ok: false,
        error: { code: 'BRIDGE_ERROR', message: err.message || '原生桥调用异常' }
      }
    }
  }
}

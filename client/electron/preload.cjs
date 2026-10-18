/**
 * preload.cjs
 * 安全暴露受控 NativeBridge 接口
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('happyGit', {
  invoke: (operation, payload = {}, contextId = null) => {
    return ipcRenderer.invoke('happyGit:invoke', {
      operation,
      payload,
      contextId
    })
  }
})

const { app, BrowserWindow, Menu } = require('electron')
const path = require('node:path')

// Disable hardware acceleration issues on some Windows systems
app.commandLine.appendSwitch('disable-gpu-sandbox')

function createWindow() {
  const win = new BrowserWindow({
    width: 440,
    height: 860,
    minWidth: 380,
    minHeight: 600,
    maxWidth: 900,
    title: 'HappyGit - 开源项目个性化推荐与展示系统',
    autoHideMenuBar: true,
    backgroundColor: '#09090b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false
    }
  })

  // Remove default menu bar
  Menu.setApplicationMenu(null)

  // Load the built dist index.html directly from local filesystem (no web port needed!)
  const indexPath = path.join(__dirname, '../dist/index.html')
  win.loadFile(indexPath).catch((err) => {
    console.error('Failed to load local app file:', err)
  })
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

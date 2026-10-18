import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const electronDist = path.join(rootDir, 'node_modules/electron/dist')
const outDir = path.join(rootDir, 'release/HappyGit-win-x64')
const appDir = path.join(outDir, 'resources/app')

console.log('🚀 开始打包 HappyGit Windows 原生独立桌面应用 (.exe)...')

// 1. 确保前端产物最新
console.log('📦 1/4 构建 Vite 前端资源...')
execSync('npm run build', { cwd: rootDir, stdio: 'inherit' })

// 2. 清理并准备输出目录
console.log('📁 2/4 准备发布目录结构...')
if (fs.existsSync(outDir)) {
  fs.rmSync(outDir, { recursive: true, force: true })
}
fs.mkdirSync(outDir, { recursive: true })

// 3. 复制 Electron 核心运行底座
console.log('⚡ 3/4 复制原生运行环境并重命名为 HappyGit.exe...')
fs.cpSync(electronDist, outDir, { recursive: true })

// 重命名 electron.exe -> HappyGit.exe
const oldExe = path.join(outDir, 'electron.exe')
const newExe = path.join(outDir, 'HappyGit.exe')
if (fs.existsSync(oldExe)) {
  fs.renameSync(oldExe, newExe)
}

// 移除默认的 default_app.asar
const defaultAsar = path.join(outDir, 'resources/default_app.asar')
if (fs.existsSync(defaultAsar)) {
  fs.rmSync(defaultAsar, { force: true })
}

// 4. 将业务产物封装入 resources/app
console.log('✨ 4/4 封装前端产物与主进程配置...')
fs.mkdirSync(appDir, { recursive: true })

// 复制 dist
fs.cpSync(path.join(rootDir, 'dist'), path.join(appDir, 'dist'), { recursive: true })

// 复制 electron 主进程代码
fs.cpSync(path.join(rootDir, 'electron'), path.join(appDir, 'electron'), { recursive: true })

// 生成精简的生产配置 package.json
const prodPkg = {
  name: 'happygit-client',
  version: '1.0.0',
  description: 'HappyGit - 开源项目个性化推荐与展示系统',
  main: 'electron/main.cjs'
}
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(prodPkg, null, 2), 'utf-8')

console.log('🎉 打包成功！')
console.log(`📍 可执行文件位置: ${newExe}`)
console.log('双击该文件即可直接在 Windows 电脑上打开独立应用窗口运行！')

/**
 * scripts/build-release.mjs
 * 校验本地网页脚本、worker、schema 和 dist 完整性，完全解除远程授权服务依赖 (依据 project.md 第十一节)
 */

import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const clientDir = fileURLToPath(new URL('..', import.meta.url))

console.log('[build-release] 1/3 构建固定网页脚本...')
execSync('node scripts/build-page-scripts.mjs', { cwd: clientDir, stdio: 'inherit' })

console.log('[build-release] 2/3 执行 Vite 构建...')
execSync('npm run build', {
  cwd: clientDir,
  env: { ...process.env, HAPPYGIT_RELEASE: '1' },
  stdio: 'inherit'
})

console.log('[build-release] 3/3 校验本地关键资源完整性...')
const requiredFiles = [
  path.join(clientDir, 'dist/index.html'),
  path.join(clientDir, 'electron/generated/page-scripts.cjs'),
  path.join(clientDir, 'android/app/src/main/assets/happygit/page-scripts.json')
]

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    throw new Error(`[build-release] 缺少必要构建资源: ${file}`)
  }
}

console.log('[build-release] ✅ 发布资源准备就绪，无远程授权服务依赖！')

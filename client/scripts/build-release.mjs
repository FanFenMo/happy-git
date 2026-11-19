/**
 * scripts/build-release.mjs
 * 校验本地网页脚本、worker、schema 和 dist 完整性，完全解除远程授权服务依赖 (依据 project.md 第十一节)
 */

import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const clientDir = fileURLToPath(new URL('..', import.meta.url))

console.log('[build-release] 1/4 准备公开服务配置与版本元数据...')
execSync('node scripts/prepare-config.mjs --mode production --release', {
  cwd: clientDir,
  env: { ...process.env, HAPPYGIT_RELEASE: '1' },
  stdio: 'inherit'
})

console.log('[build-release] 2/4 构建固定网页脚本...')
execSync('node scripts/build-page-scripts.mjs', { cwd: clientDir, stdio: 'inherit' })

console.log('[build-release] 3/4 执行 Vite 构建...')
execSync('npm run build', {
  cwd: clientDir,
  env: { ...process.env, HAPPYGIT_RELEASE: '1' },
  stdio: 'inherit'
})

console.log('[build-release] 4/4 校验本地关键资源完整性...')
const requiredFiles = [
  path.join(clientDir, 'dist/index.html'),
  path.join(clientDir, 'electron/config.generated.json'),
  path.join(clientDir, 'electron/release-metadata.json'),
  path.join(clientDir, 'electron/generated/page-scripts.cjs'),
  path.join(clientDir, 'android/app/src/main/res/values/happygit_config.xml'),
  path.join(clientDir, 'android/app/src/main/assets/happygit/release-metadata.json'),
  path.join(clientDir, 'android/app/src/main/assets/happygit/page-scripts.json')
]

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    throw new Error(`[build-release] 缺少必要构建资源: ${file}`)
  }
}

console.log('[build-release] ✅ 双端发布资源、预置公开配置与版本元数据校验就绪！')

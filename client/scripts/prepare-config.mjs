import fs from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function readPublicConfig({ rootDir = clientDir, mode = 'production', env = process.env, release = false } = {}) {
  const manifestPath = path.join(rootDir, 'public-config.json')
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {}
  const fileEnv = {}
  for (const name of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    const file = path.join(rootDir, name)
    if (fs.existsSync(file)) Object.assign(fileEnv, parseEnv(fs.readFileSync(file, 'utf8')))
  }
  const value = (env.VITE_API_BASE_URL || fileEnv.VITE_API_BASE_URL || manifest.apiBaseUrl || '').trim()
  if (!value) {
    if (release) throw new Error('发布配置缺少授权服务地址。请由项目维护者设置 public-config.json 的 apiBaseUrl 或仓库变量 HAPPYGIT_API_BASE_URL，然后重新打包。')
    return { apiBaseUrl: '' }
  }
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]', '10.0.2.2'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !release))) {
    throw new Error('授权服务地址必须是无凭据、查询参数或片段的 HTTPS 地址；本地调试可使用回环 HTTP 地址。')
  }
  if (release && loopback) throw new Error('发布安装包不能使用 localhost、回环地址或模拟器地址。请配置用户设备能够访问的 HTTPS 服务。')
  return { apiBaseUrl: url.href.replace(/\/+$/, '') }
}

export async function verifyAuthorizationService(config, fetchImpl = fetch) {
  const response = await fetchImpl(config.apiBaseUrl + '/api/auth/github/status', {
    redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' }
  })
  if (!response.ok) throw new Error(`授权服务未就绪（HTTP ${response.status}），发布已停止。`)
  const status = await response.json()
  if (status.authProtocol !== 'github-oauth-web-v1' || status.configured !== true) {
    throw new Error('授权服务未完成 GitHub 应用配置或协议版本不匹配，发布已停止。请先完成服务端部署。')
  }
}

function escapeXml(value) {
  return value.replace(/[<>&'"]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char])
}

export function writeNativeConfigs(config, rootDir = clientDir) {
  const electronDir = path.join(rootDir, 'electron')
  const androidDir = path.join(rootDir, 'android/app/src/main/res/values')
  fs.mkdirSync(electronDir, { recursive: true })
  fs.mkdirSync(androidDir, { recursive: true })
  // 只输出客户端需要的公开字段，服务端凭据不会写入安装包。
  const publicConfig = { apiBaseUrl: config.apiBaseUrl }
  fs.writeFileSync(path.join(electronDir, 'config.generated.json'), JSON.stringify(publicConfig, null, 2) + '\n')
  fs.writeFileSync(path.join(androidDir, 'happygit_config.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="happygit_api_base_url" translatable="false">${escapeXml(publicConfig.apiBaseUrl)}</string>
</resources>
`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const modeIndex = args.indexOf('--mode')
    const mode = modeIndex >= 0 ? args[modeIndex + 1] : 'production'
    const release = args.includes('--release') || process.env.HAPPYGIT_RELEASE === '1'
    const config = readPublicConfig({ mode, release })
    if (release) await verifyAuthorizationService(config)
    writeNativeConfigs(config)
    console.log(`[prepare-config] 已生成双端公开配置${release ? '，授权服务检查通过' : '（开发构建）'}`)
  } catch (error) {
    console.error(`[prepare-config] ${error.message}`)
    process.exitCode = 1
  }
}

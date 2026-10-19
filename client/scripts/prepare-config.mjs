/**
 * scripts/prepare-config.mjs
 * 客户端配置准备与可选授权服务核对 (依据 project.md 第十一节与第十二节)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function readPublicConfig({ rootDir = clientDir, env = process.env, mode = 'production', release = false } = {}) {
  let url = ''

  const pubJsonPath = path.join(rootDir, 'public-config.json')
  if (fs.existsSync(pubJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pubJsonPath, 'utf8'))
      if (parsed.apiBaseUrl) url = parsed.apiBaseUrl
    } catch {}
  }

  const envFiles = [
    path.join(rootDir, '.env'),
    path.join(rootDir, '.env.local'),
    mode ? path.join(rootDir, `.env.${mode}`) : null,
    mode ? path.join(rootDir, `.env.${mode}.local`) : null
  ].filter(Boolean)

  for (const f of envFiles) {
    if (fs.existsSync(f)) {
      const content = fs.readFileSync(f, 'utf8')
      const match = content.match(/^VITE_API_BASE_URL=(.*)$/m)
      if (match) url = match[1].trim()
    }
  }

  if (env && env.VITE_API_BASE_URL !== undefined) {
    url = env.VITE_API_BASE_URL.trim()
  }

  if (release) {
    if (!url) {
      throw new Error('缺少授权服务地址: 发布构建需要提供明确的服务地址')
    }
    if (
      url.startsWith('http://localhost') ||
      url.startsWith('https://localhost') ||
      url.startsWith('https://127.0.0.1') ||
      url.startsWith('http://127.0.0.1') ||
      url.startsWith('https://10.0.2.2') ||
      url.startsWith('http://10.0.2.2')
    ) {
      throw new Error('不能使用本地回环地址作为发布地址')
    }
    if (
      url.startsWith('http://') ||
      url.includes('@') ||
      url.includes('?') ||
      url.includes('#')
    ) {
      throw new Error('发布地址不安全: 必须为纯净 HTTPS 格式且无凭据、查询参数或 hash')
    }
  }

  return { apiBaseUrl: url.replace(/\/+$/, '') }
}

export async function verifyAuthorizationService(config, fetchFn = globalThis.fetch) {
  if (!config?.apiBaseUrl) {
    return { skipped: true }
  }
  const statusUrl = `${config.apiBaseUrl.replace(/\/+$/, '')}/api/auth/github/status`
  const res = await fetchFn(statusUrl, { redirect: 'error' })
  if (!res.ok) {
    throw new Error(`授权服务健康检查失败: HTTP ${res.status}`)
  }
  const body = await res.json()
  if (body.authProtocol !== 'github-oauth-web-v1') {
    throw new Error('授权服务协议版本不匹配: 需要 github-oauth-web-v1')
  }
  if (!body.configured) {
    throw new Error('授权服务未完成 GitHub 授权配置')
  }
  return body
}

export function writeNativeConfigs(config = { apiBaseUrl: '' }, rootDir = clientDir) {
  const electronDir = path.join(rootDir, 'electron')
  const androidDir = path.join(rootDir, 'android/app/src/main/res/values')
  fs.mkdirSync(electronDir, { recursive: true })
  fs.mkdirSync(androidDir, { recursive: true })

  // 严格过滤仅输出 apiBaseUrl，不输出任何敏感键
  const safeConfig = { apiBaseUrl: config.apiBaseUrl || '' }

  fs.writeFileSync(path.join(electronDir, 'config.generated.json'), JSON.stringify(safeConfig, null, 2) + '\n')
  fs.writeFileSync(path.join(androidDir, 'happygit_config.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="happygit_api_base_url" translatable="false">${safeConfig.apiBaseUrl}</string>
</resources>
`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeNativeConfigs()
}

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const clientDir = path.resolve(__dirname, '..')

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const content = fs.readFileSync(filePath, 'utf-8')
  const result = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim()
      let val = trimmed.slice(idx + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      result[key] = val
    }
  }
  return result
}

function readPublicConfig() {
  const envMain = parseEnvFile(path.join(clientDir, '.env'))
  const envLocal = parseEnvFile(path.join(clientDir, '.env.local'))

  const githubClientId = process.env.VITE_GITHUB_CLIENT_ID || envLocal.VITE_GITHUB_CLIENT_ID || envMain.VITE_GITHUB_CLIENT_ID || ''
  const apiBaseUrl = process.env.VITE_API_BASE_URL || envLocal.VITE_API_BASE_URL || envMain.VITE_API_BASE_URL || ''

  return {
    githubClientId: githubClientId.trim(),
    apiBaseUrl: apiBaseUrl.trim()
  }
}

function writeElectronConfig(config) {
  const electronDir = path.join(clientDir, 'electron')
  if (!fs.existsSync(electronDir)) {
    fs.mkdirSync(electronDir, { recursive: true })
  }
  const outFile = path.join(electronDir, 'config.generated.json')
  fs.writeFileSync(outFile, JSON.stringify(config, null, 2), 'utf-8')
  console.log(`[prepare-config] 已生成 Electron 配置文件: ${outFile}`)
}

function escapeXml(unsafe) {
  return (unsafe || '').replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '&': return '&amp;'
      case '\'': return '&apos;'
      case '"': return '&quot;'
      default: return c
    }
  })
}

function writeAndroidConfig(config) {
  const resValuesDir = path.join(clientDir, 'android/app/src/main/res/values')
  if (!fs.existsSync(resValuesDir)) {
    fs.mkdirSync(resValuesDir, { recursive: true })
  }
  const outFile = path.join(resValuesDir, 'happygit_config.xml')
  const xmlContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="happygit_github_client_id" translatable="false">${escapeXml(config.githubClientId)}</string>
    <string name="happygit_api_base_url" translatable="false">${escapeXml(config.apiBaseUrl)}</string>
</resources>
`
  fs.writeFileSync(outFile, xmlContent, 'utf-8')
  console.log(`[prepare-config] 已生成 Android 配置文件: ${outFile}`)
}

const config = readPublicConfig()
writeElectronConfig(config)
writeAndroidConfig(config)

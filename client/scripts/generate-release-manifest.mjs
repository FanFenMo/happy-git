#!/usr/bin/env node
/**
 * scripts/generate-release-manifest.mjs
 * 生成双端安装包 (Windows EXE/ZIP & Android APK) 的 SHA-256 摘要与版本对应清单。
 * 严禁写入任何应用密钥或用户私有凭据。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveClientVersion, resolveGitCommit, readPublicConfig } from './prepare-config.mjs'

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

export function buildReleaseManifest({
  platform,
  artifactPath,
  buildCommand = '',
  rootDir = clientDir,
  env = process.env
}) {
  const resolvedArtifact = path.resolve(artifactPath)
  if (!fs.existsSync(resolvedArtifact)) {
    throw new Error(`找不到构建产物文件: ${resolvedArtifact}`)
  }
  const stat = fs.statSync(resolvedArtifact)
  const digest = sha256File(resolvedArtifact)
  const fileName = path.basename(resolvedArtifact)

  let apiBaseUrl = ''
  const generatedConfigPath = path.join(rootDir, 'electron/config.generated.json')
  if (fs.existsSync(generatedConfigPath)) {
    try {
      apiBaseUrl = JSON.parse(fs.readFileSync(generatedConfigPath, 'utf8')).apiBaseUrl || ''
    } catch {}
  }
  if (!apiBaseUrl) {
    apiBaseUrl = readPublicConfig({ rootDir, env, mode: 'production', release: false }).apiBaseUrl || ''
  }

  return {
    schemaVersion: '1.0.0',
    platform,
    appVersion: resolveClientVersion(rootDir),
    gitCommit: resolveGitCommit(rootDir),
    apiBaseUrl,
    apiContractVersion: 'v2',
    sqliteSchemaVersion: platform === 'android' ? 'v4' : 'v3-round2',
    artifact: {
      fileName,
      byteSize: stat.size,
      sha256: digest
    },
    buildCommand,
    generatedAt: new Date().toISOString()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const readArg = (flag, fallback = '') => {
    const idx = args.indexOf(flag)
    return (idx >= 0 && args[idx + 1]) ? args[idx + 1] : fallback
  }
  const platform = readArg('--platform', 'windows')
  const artifactPath = readArg('--artifact')
  const outputManifest = readArg('--output')
  const buildCommand = readArg('--build-command', '')
  if (!artifactPath) {
    console.error('用法: node scripts/generate-release-manifest.mjs --platform <windows|android> --artifact <file> [--output <manifest.json>]')
    process.exit(1)
  }
  const manifest = buildReleaseManifest({ platform, artifactPath, buildCommand })
  const resolvedArtifact = path.resolve(artifactPath)
  fs.writeFileSync(
    `${resolvedArtifact}.sha256`,
    `${manifest.artifact.sha256}  ${manifest.artifact.fileName}\n`,
    'utf8'
  )
  const manifestTarget = outputManifest
    ? path.resolve(outputManifest)
    : path.join(path.dirname(resolvedArtifact), `release-manifest-${platform}.json`)
  fs.writeFileSync(manifestTarget, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify(manifest, null, 2))
}

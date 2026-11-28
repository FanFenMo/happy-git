import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { startDatabaseWorker, callDatabase, closeDatabaseWorker } = require('../electron/database.cjs')
const { CloudService } = require('../electron/cloud-service.cjs')

test('授权成功且服务端支持即时画像时，自动开启分析、上传并更新本地云端画像缓存，且修复脏登录名', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happygit-auto-portrait-'))
  const dbPath = path.join(tmpDir, 'happygit.db')
  await startDatabaseWorker(dbPath)

  try {
    const accountId = '210000727'
    // 写入含代词后缀的脏 login 以及假空同步状态，测试打开/自愈与采集同步
    await callDatabase('saveProfile', {
      accountId,
      profile: {
        accountId,
        login: 'FanFenMo · he/him',
        displayName: 'FanFenMo',
        fetchedAt: Date.now()
      }
    })
    await closeDatabaseWorker()
    await startDatabaseWorker(dbPath)

    const healed = await callDatabase('readAccountSnapshot', { accountId })
    assert.equal(healed.profile.login, 'FanFenMo')
    assert.equal(healed.profile.profileUrl, 'https://github.com/FanFenMo')

    // 写入一个无数字 repoId 的真实网页抓取仓库，确认仍能同步集合快照
    const { generationId } = await callDatabase('beginSync', { accountId, kind: 'repos' })
    await callDatabase('writeSyncPage', {
      accountId,
      kind: 'repos',
      generationId,
      pageSeq: 1,
      items: [{
        repoId: null,
        canonicalKey: 'fanfenmo/happy-git',
        fullName: 'FanFenMo/happy-git',
        name: 'happy-git',
        primaryLanguage: 'Vue',
        description: 'Open source recommendation with Hadoop',
        visibility: 'public'
      }],
      nextUrl: null
    })
    await callDatabase('finishSync', { accountId, kind: 'repos', generationId })

    let serverAnalysisEnabled = false
    let serverEpoch = 1
    let serverRevision = 0
    const calls = []

    const spaceObj = {
      kind: 'feature_space',
      dimension: 8192,
      language: { Vue: 0 },
      topic: { hadoop: 1 },
      text: { recommendation: { index: 2, idf: 2.1 } }
    }
    const spaceLine = JSON.stringify(spaceObj)
    const spaceDigest = crypto.createHash('sha256').update(spaceLine + '\n', 'utf8').digest('hex')

    const cloudService = new CloudService({
      database: { callDatabase },
      defaultBaseUrl: 'http://127.0.0.1:8080',
      fetchImpl: async (url, options = {}) => {
        const route = new URL(url).pathname
        const body = options.body ? JSON.parse(options.body) : null
        calls.push({ method: options.method || 'GET', route, body })

        if (route === '/api/v2/auth/github/begin') {
          assert.equal(body.login, 'FanFenMo')
          assert.equal(body.accountId, accountId)
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              challengeId: 'ch_auto_1',
              authorizationUrl: 'http://127.0.0.1:8080/api/v2/auth/github/local-authorize?state=s1',
              expiresAt: Date.now() + 60000
            })
          }
        }
        if (route === '/api/v2/auth/github/poll') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              state: 'authenticated',
              supportsInstantPortrait: true,
              accessToken: 'at_1',
              refreshToken: 'rt_1',
              expiresAt: Date.now() + 3600000,
              subjectId: 'subj_1',
              accountId
            })
          }
        }
        if (route === '/api/v2/devices/register') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              deviceId: 'dev_1',
              streamEpoch: '11111111-2222-4333-8444-555555555555',
              analysisEpoch: serverEpoch,
              acceptedThrough: 0,
              exportedThrough: 0,
              processedThrough: 0,
              preferences: { analysisEnabled: serverAnalysisEnabled, revision: serverRevision }
            })
          }
        }
        if (route === '/api/v2/me/preferences') {
          if ((options.method || 'GET') === 'GET') {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                revision: serverRevision,
                analysisEpoch: serverEpoch,
                analysisEnabled: serverAnalysisEnabled,
                manualTags: [],
                hiddenRepoIds: []
              })
            }
          }
          if (body.analysisEnabled !== serverAnalysisEnabled) serverEpoch += 1
          serverAnalysisEnabled = Boolean(body.analysisEnabled)
          serverRevision += 1
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              revision: serverRevision,
              analysisEpoch: serverEpoch,
              analysisEnabled: serverAnalysisEnabled,
              manualTags: body.manualTags || [],
              hiddenRepoIds: body.hiddenRepoIds || []
            })
          }
        }
        if (route === '/api/v2/me/collections') {
          assert.ok(body.repoIds.includes('fanfenmo__happy-git'))
          serverRevision += 1
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ revision: serverRevision, analysisEpoch: serverEpoch, complete: true })
          }
        }
        if (route === '/api/v2/me/portrait/refresh') {
          assert.equal(body.owned.length, 1)
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              subjectId: 'subj_1',
              analysisEpoch: serverEpoch,
              status: 'ready',
              modelVersion: 'portrait-101f749d459768596fbb3275',
              featureSpaceVersion: spaceDigest,
              generationId: 'gen-live-test1',
              generatedAt: Date.now(),
              processedThrough: {},
              profile: {
                languages: { Vue: 1.0 },
                topics: { hadoop: 1.0 },
                directions: [{ directionId: 'direction-01', label: 'Vue · hadoop 方向', weight: 1.0, languages: ['Vue'], topics: ['hadoop'] }],
                topInterests: [{ tag: 'hadoop', score: 1.0, evidenceRepos: ['FanFenMo/happy-git'] }],
                evidenceRepos: [{ fullName: 'FanFenMo/happy-git', primaryLanguage: 'Vue', sources: ['owned'], weight: 1.5 }]
              },
              searchPlan: {
                generationId: 'gen-live-test1',
                queries: [{ id: 'dir_1', language: 'Vue', topics: ['hadoop'], sort: 'updated' }]
              }
            })
          }
        }
        if (route === `/api/v2/feature-spaces/${spaceDigest}`) {
          return { ok: true, status: 200, text: async () => spaceLine + '\n' }
        }
        throw new Error(`Unexpected path: ${route}`)
      }
    })

    const beginRes = await cloudService.beginAuth({ accountId, login: 'FanFenMo · he/him' }, { openBrowser: false })
    assert.ok(beginRes.challengeId)

    const pollRes = await cloudService.pollAuth({ accountId }, { challengeId: beginRes.challengeId })
    assert.equal(pollRes.state, 'authenticated')
    assert.equal(pollRes.cloudSync.cloudBound, true)
    assert.equal(pollRes.cloudSync.analysisEnabled, true)
    assert.equal(pollRes.cloudPortrait.status, 'ready')
    assert.equal(pollRes.cloudPortrait.generationId, 'gen-live-test1')
    assert.equal(pollRes.cloudPortrait.portrait.directions[0].label, 'Vue · hadoop 方向')
    assert.ok(calls.some(c => c.route === '/api/v2/me/portrait/refresh'))
  } finally {
    await closeDatabaseWorker()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

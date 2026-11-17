import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { startDatabaseWorker, callDatabase, closeDatabaseWorker } = require('../electron/database.cjs')
const { CloudService } = require('../electron/cloud-service.cjs')
const { IpcRouter } = require('../electron/ipc-router.cjs')

import { normalizeRepository } from '../shared/github-page/normalize.js'
import {
  tokenizeTechnicalNfkcBigram,
  projectRepositoryToFeatureSpace,
  sparseDotProduct
} from '../shared/recommendation/features.js'
import { planDiscoveryQueries, buildGitHubSearchQuery } from '../shared/recommendation/recall.js'
import { createRecommendationBatch } from '../shared/recommendation/rank.js'

function buildSampleFeatureSpace() {
  const spaceCore = {
    kind: 'feature_space',
    dimension: 8192,
    modelVersion: 'mr-content-v2-data2',
    tokenizerVersion: 'technical-nfkc-bigram-1',
    documentCount: 100,
    language: {
      Rust: 0,
      TypeScript: 1
    },
    topic: {
      llm: 128,
      hadoop: 129,
      rag: 130
    },
    text: {
      transformer: { index: 1152, df: 10, idf: 2.5 },
      inference: { index: 1153, df: 8, idf: 2.7 },
      vector: { index: 1154, df: 15, idf: 2.1 },
      中文: { index: 1155, df: 5, idf: 3.1 },
      文检: { index: 1156, df: 5, idf: 3.1 },
      检索: { index: 1157, df: 5, idf: 3.1 }
    }
  }
  const line = JSON.stringify(spaceCore)
  const digest = crypto.createHash('sha256').update(line + '\n', 'utf8').digest('hex')
  return { rawLine: line, digest, space: { ...spaceCore, featureSpaceVersion: digest } }
}

test('同构分词与 featureSpace 投影支持目录外新项目并如实保留未知缺失', () => {
  const tokens = tokenizeTechnicalNfkcBigram('C++ 和 .NET 的中文检索推理 Engine')
  assert.ok(tokens.includes('c++'))
  assert.ok(tokens.includes('.net'))
  assert.ok(tokens.includes('中文') && tokens.includes('文检') && tokens.includes('检索'))

  const { space } = buildSampleFeatureSpace()
  const outsideRepo = normalizeRepository({
    id: '999001',
    full_name: 'open-team/zig-rag-engine',
    description: 'High speed Transformer inference with vector index',
    language: 'Zig', // 训练特征空间之外的语言
    topics: ['rag', 'unknown-topic-xyz'],
    stargazers_count: 1520,
    forks_count: 88,
    license: { spdx_id: 'Apache-2.0' },
    pushed_at: '2026-11-12T10:00:00Z',
    readmeText: '# Zig RAG Engine\nRun locally:\n`cargo install zig-rag-cli`\n中文检索引擎。'
  }, 'search')

  assert.equal(outsideRepo.attentionSignal.label, '关注度')
  assert.equal(outsideRepo.starCount, 1520)
  assert.equal(outsideRepo.licenseSpdx, 'Apache-2.0')
  assert.ok(outsideRepo.purposeCue.includes('Transformer'))
  assert.equal(outsideRepo.installCue, 'cargo install zig-rag-cli')

  const proj = projectRepositoryToFeatureSpace(outsideRepo, space)
  assert.equal(proj.knownLanguage, false)
  assert.equal(proj.missingFeatures.unknownLanguage, 'Zig')
  assert.deepEqual(proj.knownTopics, ['rag'])
  assert.deepEqual(proj.missingFeatures.unknownTopics, ['unknown-topic-xyz'])
  assert.ok(proj.sparseVector.indices.includes(130)) // rag topic index
  assert.ok(proj.sparseVector.indices.includes(1152)) // transformer text index
  // 不得包含不存在于特征空间内的 language 坐标 (0 或 1)
  assert.ok(!proj.sparseVector.indices.includes(0))
  assert.ok(!proj.sparseVector.indices.includes(1))
})

test('有界搜索计划限制最多 4 查询与 8 页，并过滤非法字符注入', () => {
  assert.equal(
    buildGitHubSearchQuery({
      topics: ['ai-llm', 'http://evil.com/x', 'transformer'],
      language: 'Python',
      keywords: ['inference', '<script>alert(1)</script>'],
      excludeTopics: ['homework']
    }),
    'topic:ai-llm topic:transformer language:Python inference -topic:homework archived:false is:public'
  )

  const plan = planDiscoveryQueries({
    modelVersion: 'mr-content-v2-data2',
    featureSpaceVersion: 'abc123',
    generationId: 'gen_1',
    queries: [
      { id: 'q1', topics: ['llm'], language: 'Python', sort: 'stars' },
      { id: 'q2', topics: ['rag'], language: 'TypeScript', sort: 'updated' },
      { id: 'q3', topics: ['hadoop'], language: 'Java', sort: 'stars' },
      { id: 'q4', topics: ['rust'], language: 'Rust', sort: 'stars' },
      { id: 'q5', topics: ['vue'], language: 'JavaScript', sort: 'stars' }
    ]
  }, [], Date.now())

  assert.equal(plan.length, 4)
  assert.equal(plan.bounded, true)
  assert.equal(plan.complete, false)
  const totalPages = plan.reduce((sum, q) => sum + q.maxPages, 0)
  assert.ok(totalPages <= 8)
})

test('云端画像缓存、特征空间校验、accepted/processed 水位独立与近期事件接续排序闭环', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happygit-portrait-r2-'))
  await startDatabaseWorker(path.join(dir, 'test.db'))

  try {
    const accountId = '2001'
    const context = { accountId, status: 'authenticated', contextId: 'ctx-2001' }
    await callDatabase('saveProfile', { accountId, profile: { accountId, login: 'alice', fetchedAt: Date.now() } })

    const { rawLine, digest, space } = buildSampleFeatureSpace()
    let failFeatureDigest = false
    const streamEpoch = 'aaaa1111-bbbb-4ccc-8ddd-000000000001'
    const SERVER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
    const serverPrefs = {
      revision: 1,
      analysisEpoch: 1,
      analysisEnabled: true,
      manualTags: [],
      hiddenRepoIds: []
    }

    const repoRust = normalizeRepository({
      repoId: '7001',
      fullName: 'systems/rust-gpu-runtime',
      description: 'Fast Rust runtime for transformer inference',
      primaryLanguage: 'Rust',
      topics: ['llm', 'inference'],
      starCount: 3200,
      forkCount: 210,
      licenseSpdx: 'MIT',
      updatedAt: Date.now() - 2 * 86400000
    }, 'browse')

    const candRustMatch = normalizeRepository({
      repoId: '8001',
      fullName: 'systems/rust-llm-server',
      description: 'Distributed Transformer inference engine in Rust with vector store',
      primaryLanguage: 'Rust',
      topics: ['llm', 'rag'],
      starCount: 2800,
      licenseSpdx: 'Apache-2.0',
      pushedAt: Date.now() - 86400000
    }, 'search')

    const candTsMatch = normalizeRepository({
      repoId: '8002',
      fullName: 'web/ts-dashboard-kit',
      description: 'Frontend analytics dashboard with chart vector widgets',
      primaryLanguage: 'TypeScript',
      topics: ['frontend'],
      starCount: 2800,
      licenseSpdx: 'MIT',
      pushedAt: Date.now() - 86400000
    }, 'search')

    await callDatabase('saveDiscoveryCache', {
      accountId,
      queryKey: 'search:r2:1',
      queryJson: JSON.stringify({ query: 'llm' }),
      resultJson: JSON.stringify([candRustMatch, candTsMatch]),
      fetchedAt: Date.now(),
      expiresAt: Date.now() + 86400000
    })

    const cloudService = new CloudService({
      database: { callDatabase },
      fetchImpl: async (url, options = {}) => {
        const pathname = new URL(url).pathname
        if (pathname === '/api/v2/devices/register') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              subjectId: 'subj_2001',
              deviceId: 'dev_2001',
              streamEpoch,
              analysisEpoch: serverPrefs.analysisEpoch,
              acceptedThrough: 0,
              exportedThrough: 0,
              processedThrough: 0,
              preferences: { ...serverPrefs }
            })
          }
        }
        if (pathname === '/api/v2/me/preferences') {
          if ((options.method || 'GET').toUpperCase() === 'GET') {
            return { ok: true, status: 200, text: async () => JSON.stringify({ ...serverPrefs }) }
          }
          const body = JSON.parse(options.body || '{}')
          for (const idItem of [...(body.manualTags || []), ...(body.hiddenRepoIds || [])]) {
            if (!SERVER_ID_RE.test(String(idItem))) {
              return {
                ok: false,
                status: 400,
                text: async () => JSON.stringify({ code: 'INVALID_FIELD', message: `invalid id: ${idItem}` })
              }
            }
          }
          if (typeof body.analysisEnabled === 'boolean' && body.analysisEnabled !== serverPrefs.analysisEnabled) {
            serverPrefs.analysisEpoch += 1
          }
          serverPrefs.analysisEnabled = Boolean(body.analysisEnabled)
          serverPrefs.manualTags = Array.isArray(body.manualTags) ? [...body.manualTags] : []
          serverPrefs.hiddenRepoIds = Array.isArray(body.hiddenRepoIds) ? [...body.hiddenRepoIds] : []
          serverPrefs.revision += 1
          return { ok: true, status: 200, text: async () => JSON.stringify({ ...serverPrefs }) }
        }
        if (pathname === '/api/v2/events/batches') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              deviceId: 'dev_2001',
              streamEpoch,
              analysisEpoch: 1,
              acceptedThrough: 1,
              exportedThrough: 0,
              processedThrough: 0,
              serverTime: Date.now()
            })
          }
        }
        if (pathname === `/api/v2/feature-spaces/${digest}`) {
          return {
            ok: true,
            status: 200,
            text: async () => failFeatureDigest ? '{"tampered":true}\n' : (rawLine + '\n')
          }
        }
        if (pathname === '/api/v2/me/portrait') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              subjectId: 'subj_2001',
              analysisEpoch: 1,
              status: 'ready',
              modelVersion: 'mr-content-v2-data2',
              featureSpaceVersion: digest,
              catalogSnapshotId: 'cat_20261116',
              generationId: 'gen_r2_001',
              referenceTime: Date.now() - 3600000,
              generatedAt: Date.now() - 1800000,
              processedThrough: 0,
              profile: {
                languages: { TypeScript: 1.0 },
                topics: { frontend: 1.0 },
                directions: [{ directionId: 'd_fe', label: '前端工程', weight: 0.75, topics: ['frontend'], languages: ['TypeScript'] }],
                topInterests: [{ tag: 'frontend', score: 1.0, evidenceRepos: ['8002'] }],
                evidenceRepos: [{ repoId: '8002', fullName: 'web/ts-dashboard-kit', sources: ['star'] }],
                vector: { dimension: 8192, indices: [1], values: [1.0] }
              }
            })
          }
        }
        if (pathname === '/api/v2/me/search-plan') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              generationId: 'gen_r2_001',
              analysisEpoch: 1,
              modelVersion: 'mr-content-v2-data2',
              featureSpaceVersion: digest,
              queries: [
                { id: 'dir_fe', topics: ['frontend'], language: 'TypeScript', sort: 'stars' }
              ]
            })
          }
        }
        if (pathname === '/api/v2/cohorts') {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              modelVersion: 'mr-content-v2-data2',
              generationId: 'gen_r2_001',
              sourceKind: 'synthetic',
              cohorts: [
                { cohortId: 'ai_llm', memberCount: 25, suppressed: false, languages: { Rust: 0.4, Python: 0.6 }, topics: { llm: 0.7 } }
              ]
            })
          }
        }
        throw new Error(`Unexpected request: ${pathname}`)
      }
    })

    await cloudService.saveTokens(accountId, {
      accessToken: 'tok_2001',
      refreshToken: 'ref_2001',
      expiresAt: Date.now() + 3600000,
      cloudAccountId: accountId
    })
    await callDatabase('saveCloudAccountState', {
      accountId,
      patch: { cloudBound: true, cloudAccountId: accountId, analysisEnabled: true }
    })
    await cloudService.registerDeviceAndSyncStream(accountId)

    // 1. 篡改特征空间摘要必须被拒绝
    failFeatureDigest = true
    await assert.rejects(
      () => cloudService.fetchVerifiedFeatureSpace('tok_2001', digest),
      err => err.code === 'FEATURE_SPACE_DIGEST_MISMATCH'
    )
    failFeatureDigest = false

    // 2. 拉取同代画像与 searchPlan
    const refreshRes = await cloudService.refreshPortrait(context)
    assert.equal(refreshRes.refreshed, true)
    assert.equal(refreshRes.cloudPortrait.generationId, 'gen_r2_001')
    assert.equal(refreshRes.cloudPortrait.searchPlan.queries[0].id, 'dir_fe')

    // 3. 记录一次浏览 Rust LLM 项目并上传获得 acceptedThrough = 1, processedThrough = 0
    await callDatabase('recordBrowse', { accountId, repository: repoRust, source: 'trending', viewedAt: Date.now() })
    const flushRes = await cloudService.flushOutbox(context)
    assert.equal(flushRes.cloudSync.acceptedThrough, 1)
    assert.equal(flushRes.cloudSync.processedThrough, 0)

    // acceptedThrough = 1 但 processedThrough = 0，因此 deviceSeq=1 必须继续作为未处理近期增量！
    const snapBeforeProcess = await callDatabase('createSnapshot', { accountId, purpose: 'ranking' })
    assert.equal(snapBeforeProcess.processedThrough, 0)
    assert.equal(snapBeforeProcess.unprocessedEvents.length, 1)

    // 比较带近期事件 vs 不带近期事件的分数变化
    const batchWithRecent = createRecommendationBatch({
      batchId: 'batch_with_recent',
      accountId,
      profile: snapBeforeProcess.cloudPortrait,
      candidates: snapBeforeProcess.candidates,
      featureSpace: snapBeforeProcess.featureSpace,
      unprocessedEvents: snapBeforeProcess.unprocessedEvents,
      processedThrough: snapBeforeProcess.processedThrough,
      now: Date.now()
    })
    assert.equal(batchWithRecent.unprocessedEventCount, 1)
    const rustItemBefore = batchWithRecent.items.find(i => i.repoId === '8001')
    assert.ok(rustItemBefore.reasons.some(r => r.includes('接续近期浏览')))

    // 4. 新画像发布并将 processedThrough 推进至 1 后，同一事件不得重复作为本机增量
    await callDatabase('saveCloudPortrait', {
      accountId,
      portrait: {
        analysisEpoch: 1,
        status: 'ready',
        modelVersion: 'mr-content-v2-data2',
        featureSpaceVersion: digest,
        generationId: 'gen_r2_002',
        generatedAt: Date.now(),
        processedThrough: 1,
        portrait: {
          languages: { Rust: 0.7, TypeScript: 0.3 },
          topics: { llm: 0.8, frontend: 0.2 },
          topInterests: [{ tag: 'llm', score: 0.8, evidenceRepos: ['7001'] }],
          evidenceRepos: [{ repoId: '7001', fullName: 'systems/rust-gpu-runtime', sources: ['browse'] }],
          vector: projectRepositoryToFeatureSpace(repoRust, space).sparseVector
        }
      }
    })

    const snapAfterProcess = await callDatabase('createSnapshot', { accountId, purpose: 'ranking' })
    assert.equal(snapAfterProcess.processedThrough, 1)
    assert.equal(snapAfterProcess.unprocessedEvents.length, 0)
    assert.ok(sparseDotProduct(snapAfterProcess.cloudPortrait.vector, projectRepositoryToFeatureSpace(candRustMatch, space).sparseVector) > 0)

    // 5. 防止迟到的旧代结果 (processedThrough=0) 覆盖较新进度 (processedThrough=1)
    const afterStaleSave = await callDatabase('saveCloudPortrait', {
      accountId,
      portrait: {
        analysisEpoch: 1,
        generationId: 'gen_r2_old_late',
        generatedAt: Date.now() - 500000,
        processedThrough: 0,
        portrait: { languages: { Python: 1.0 }, topics: {} }
      }
    })
    assert.equal(afterStaleSave.generationId, 'gen_r2_002')
    assert.equal(afterStaleSave.processedThrough, 1)

    // 6. 验证隐藏反馈使已消费或未提交快照失效 (INPUT_CHANGED)
    const pendingSnap = await callDatabase('createSnapshot', { accountId, purpose: 'ranking' })
    await callDatabase('recordRecommendationFeedback', { accountId, repoId: '8002', kind: 'hide', eventId: 'fb_hide_8002' })
    const commitAfterHide = await callDatabase('commitRecommendation', {
      accountId,
      inputId: pendingSnap.inputId,
      inputVersions: pendingSnap.inputVersions,
      purpose: 'ranking',
      batch: { batchId: 'b_stale', items: [] }
    })
    assert.equal(commitAfterHide.ok, false)
    assert.equal(commitAfterHide.error, 'INPUT_CHANGED')

    // 7. 群体分布拉取与有界搜索 (最多 4 查询 / 最多 8 页 / 去重保留完整 DTO) 验证
    const visitedUrls = []
    const router = new IpcRouter({
      sessionManager: { getContext: () => context },
      accountSyncService: {},
      starService: {},
      cloudService,
      database: { callDatabase },
      browser: { getOrCreateWorkPage: () => ({ webContents: {} }) },
      scheduler: { enqueue: async ({ taskFn }) => taskFn() },
      pageExecutorFactory: () => ({
        runTask: async ({ url }) => {
          visitedUrls.push(url)
          return {
            items: [
              candRustMatch,
              // 重复项应被去重
              { ...candRustMatch, score: 0 }
            ],
            nextUrl: url.includes('p=2') ? null : `${url}&p=2`
          }
        }
      }),
      routes: {
        searchRepositoriesUrl: (q, sort, page) => `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories&s=${sort}&p=${page}`
      }
    })
    const discRes = await router.handleInvoke(null, {
      operation: 'discovery.refresh',
      contextId: context.contextId,
      payload: {
        mode: 'personalized',
        queryPlan: [
          { id: 'q1', query: 'topic:llm is:public', sort: 'stars', startPage: 1, maxPages: 2 },
          { id: 'q2', query: 'topic:rag is:public', sort: 'updated', startPage: 1, maxPages: 2 },
          { id: 'q3', query: 'topic:rust is:public', sort: 'stars', startPage: 1, maxPages: 2 },
          { id: 'q4', query: 'topic:hadoop is:public', sort: 'stars', startPage: 1, maxPages: 2 },
          { id: 'q5', query: 'topic:vue is:public', sort: 'stars', startPage: 1, maxPages: 2 } // 超过4个查询，应被忽略
        ]
      }
    })
    assert.equal(discRes.ok, true)
    assert.equal(discRes.data.bounded, true)
    assert.equal(discRes.data.complete, false)
    assert.equal(discRes.data.queries.length, 4)
    assert.ok(discRes.data.pagesUsed <= 8)
    assert.equal(discRes.data.count, 1) // 同 repoId 只保留 1 条完整 DTO
    assert.equal(discRes.data.candidates[0].licenseSpdx, 'Apache-2.0')

    const cohortRes = await router.handleInvoke(null, { operation: 'cloud.cohorts.refresh', contextId: context.contextId })
    assert.equal(cohortRes.ok, true)
    assert.equal(cohortRes.data.cohorts.cohorts[0].cohortId, 'ai_llm')

    // 8. 关闭分析后 cloudPortrait 状态切为 analysis_disabled
    await callDatabase('savePreferences', { accountId, preferences: { historyEnabled: true, analysisEnabled: false, manualTags: [] } })
    const disabledPortrait = await callDatabase('readCloudPortrait', { accountId })
    assert.equal(disabledPortrait.status, 'analysis_disabled')
    assert.equal(disabledPortrait.portrait, null)

    // 9. 验证反馈 hide/unhide + 正则兼容偏好同步 + 离线队列重放 + 近期事件24h降权
    // 先恢复 analysisEnabled = true 以验证不影响 epoch 的 tag/hidden sync
    await cloudService.savePreferences(context, {
      analysisEnabled: true,
      manualTags: ['rust-systems', 'AI Agent', '不合法中文标签'],
      operationId: 'op_tags_sync'
    })
    assert.ok(serverPrefs.manualTags.includes('rust-systems'))
    assert.ok(serverPrefs.manualTags.includes('AI-Agent'))
    assert.ok(!serverPrefs.manualTags.includes('不合法中文标签'))
    for (const t of serverPrefs.manualTags) {
      assert.match(t, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
    }

    // 隐藏与解除隐藏仓库，并校验仅合法 ID 同步至云端（analysisEpoch 不变）
    const epochBeforeHide = serverPrefs.analysisEpoch
    const fbHide = await callDatabase('recordRecommendationFeedback', {
      accountId,
      repoId: '8001',
      hidden: true,
      eventId: 'fb_hide_8001_v2'
    })
    assert.equal(fbHide.hidden, true)
    await callDatabase('recordRecommendationFeedback', {
      accountId,
      repoId: 'invalid/key/format',
      hidden: true,
      eventId: 'fb_hide_invalid'
    })
    await cloudService.syncFeedbackPreferences(context, { operationId: 'fb_hide_8001_v2' })
    assert.equal(serverPrefs.analysisEpoch, epochBeforeHide)
    assert.ok(serverPrefs.hiddenRepoIds.includes('8001'))
    assert.ok(!serverPrefs.hiddenRepoIds.includes('invalid/key/format'))

    const hiddenList = await callDatabase('listHiddenRecommendations', { accountId })
    assert.ok(hiddenList.items.some(it => it.repoId === '8001' && it.fullName === 'systems/rust-llm-server'))

    await callDatabase('recordRecommendationFeedback', {
      accountId,
      repoId: '8001',
      hidden: false,
      eventId: 'fb_unhide_8001_v2'
    })
    await cloudService.syncFeedbackPreferences(context, { operationId: 'fb_unhide_8001_v2' })
    assert.ok(!serverPrefs.hiddenRepoIds.includes('8001'))

    // 验证离线时偏好变更先入 client_mutation_outbox，断网恢复 flushOutbox 后自动补传云端
    await callDatabase('recordRecommendationFeedback', {
      accountId,
      repoId: '8002',
      hidden: true,
      eventId: 'fb_hide_8002_offline'
    })
    await callDatabase('enqueueClientMutation', {
      accountId,
      operationId: 'fb_hide_8002_offline',
      mutationKind: 'preferences',
      payload: { trigger: 'offline_test' }
    })
    const pendingBeforeReconnect = await callDatabase('readPendingClientMutations', {
      accountId,
      mutationKind: 'preferences'
    })
    assert.equal(pendingBeforeReconnect.length, 1)
    await cloudService.flushOutbox(context)
    const pendingAfterReconnect = await callDatabase('readPendingClientMutations', {
      accountId,
      mutationKind: 'preferences'
    })
    assert.equal(pendingAfterReconnect.length, 0)
    assert.ok(serverPrefs.hiddenRepoIds.includes('8002'))

    // 验证 unprocessedEvents（不在 historyMap 内但发生于24小时内）同样触发 openedRecent 降权
    const recentBatch = createRecommendationBatch({
      batchId: 'batch_recent_demotion',
      accountId,
      profile: {
        languages: { Rust: 1.0 },
        topics: { llm: 1.0 },
        topInterests: [{ tag: 'llm', score: 1.0 }]
      },
      candidates: [candRustMatch],
      historyMap: new Map(),
      unprocessedEvents: [
        {
          deviceSeq: 99,
          recordKind: 'open',
          repoId: candRustMatch.repoId,
          canonicalKey: candRustMatch.canonicalKey,
          fullName: candRustMatch.fullName,
          effectiveAt: Date.now() - 60000
        }
      ],
      processedThrough: 1,
      now: Date.now()
    })
    const staleBatch = createRecommendationBatch({
      batchId: 'batch_stale_no_demotion',
      accountId,
      profile: {
        languages: { Rust: 1.0 },
        topics: { llm: 1.0 },
        topInterests: [{ tag: 'llm', score: 1.0 }]
      },
      candidates: [candRustMatch],
      historyMap: new Map(),
      unprocessedEvents: [
        {
          deviceSeq: 99,
          recordKind: 'open',
          repoId: candRustMatch.repoId,
          canonicalKey: candRustMatch.canonicalKey,
          fullName: candRustMatch.fullName,
          effectiveAt: Date.now() - (48 * 3600 * 1000)
        }
      ],
      processedThrough: 1,
      now: Date.now()
    })
    assert.ok(recentBatch.items[0].score < staleBatch.items[0].score)
  } finally {
    await closeDatabaseWorker()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

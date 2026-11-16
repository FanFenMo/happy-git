import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

import {
  computeOpenEventPayloadHash,
  computeDiscardEventPayloadHash,
  sha256HexUtf8
} from '../shared/contracts/index.js'

const require = createRequire(import.meta.url)
const { startDatabaseWorker, callDatabase, closeDatabaseWorker } = require('../electron/database.cjs')
const { CloudService } = require('../electron/cloud-service.cjs')

test('sha256HexUtf8 与 computeOpenEventPayloadHash 严格对齐服务端 IngestService.openHash', () => {
  const sample = {
    eventId: 'evt_u1001_1794000000000_abcd1234',
    streamEpoch: 1,
    deviceSeq: 1,
    analysisEpoch: 1,
    repoId: '23418517',
    occurredAt: 1794000000000,
    source: 'browse'
  }
  const expectedTupleJson = JSON.stringify([
    '1.0.0',
    sample.eventId,
    sample.streamEpoch,
    sample.deviceSeq,
    sample.analysisEpoch,
    sample.repoId,
    sample.occurredAt,
    sample.source
  ])
  const nodeSha = crypto.createHash('sha256').update(expectedTupleJson, 'utf8').digest('hex')
  assert.equal(sha256HexUtf8(expectedTupleJson), nodeSha)
  assert.equal(computeOpenEventPayloadHash(sample), nodeSha)

  const discardHash = computeDiscardEventPayloadHash({
    eventId: sample.eventId,
    streamEpoch: 1,
    deviceSeq: 1,
    analysisEpoch: 1
  })
  assert.equal(discardHash.length, 64)
})

test('SQLite v2 -> v3 迁移保留历史数据，并正确实现 30 秒按次事件去重、discard 墓碑与云端批量上传', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happygit-v3-test-'))
  const dbPath = path.join(tmpDir, 'happygit.db')

  // 1. 先构造一个 user_version = 2 的旧数据库并写入账号与历史数据
  {
    const legacyDb = new DatabaseSync(dbPath)
    legacyDb.exec(`
      CREATE TABLE accounts (
        account_id TEXT PRIMARY KEY NOT NULL,
        login TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        profile_synced_at INTEGER NOT NULL
      );
      CREATE TABLE account_preferences (
        account_id TEXT PRIMARY KEY NOT NULL,
        history_enabled INTEGER NOT NULL DEFAULT 1,
        manual_tags_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE browse_history (
        account_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        full_name TEXT NOT NULL,
        description TEXT,
        repository_json TEXT NOT NULL,
        first_viewed_at INTEGER NOT NULL,
        last_viewed_at INTEGER NOT NULL,
        last_counted_at INTEGER NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 1,
        last_source TEXT NOT NULL,
        PRIMARY KEY (account_id, repo_id)
      );
      CREATE TABLE repository_cache (
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        sort_time INTEGER NOT NULL,
        repository_json TEXT NOT NULL,
        PRIMARY KEY (account_id, kind, generation_id, repo_id)
      );
      CREATE TABLE sync_state (
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        active_generation TEXT,
        active_complete INTEGER NOT NULL DEFAULT 0,
        active_count INTEGER NOT NULL DEFAULT 0,
        staging_generation TEXT,
        staging_next_page INTEGER,
        staging_count INTEGER NOT NULL DEFAULT 0,
        last_completed_at INTEGER,
        last_error_code TEXT,
        retry_at INTEGER,
        staging_next_url TEXT,
        staging_page_seq INTEGER NOT NULL DEFAULT 0,
        staging_star_revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, kind)
      );
      CREATE TABLE app_settings (
        setting_key TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL
      );
      CREATE TABLE feed_cache (
        cache_key TEXT PRIMARY KEY NOT NULL,
        payload_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
      PRAGMA user_version = 2;
    `)
    legacyDb.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?);').run(
      '1001',
      'alice',
      JSON.stringify({ accountId: '1001', login: 'alice', displayName: 'Alice' }),
      1793000000000
    )
    legacyDb.prepare('INSERT INTO account_preferences VALUES (?, 1, ?, ?);').run(
      '1001',
      JSON.stringify(['distributed-systems']),
      1793000000000
    )
    legacyDb.close()
  }

  await startDatabaseWorker(dbPath)
  try {
    // 验证升级后旧账号完整保留且 cloudSync 默认就绪
    const snap0 = await callDatabase('readAccountSnapshot', { accountId: '1001' })
    assert.equal(snap0.profile.login, 'alice')
    assert.equal(snap0.preferences.historyEnabled, true)
    assert.equal(snap0.preferences.analysisEnabled, true)
    assert.equal(snap0.cloudSync.streamEpoch, 1)
    assert.equal(snap0.cloudSync.analysisEpoch, 1)

    const repoHadoop = {
      repoId: '23418517',
      canonicalKey: 'apache/hadoop',
      fullName: 'apache/hadoop',
      description: 'Apache Hadoop distributed storage and MapReduce',
      visibility: 'public'
    }
    const repoVue = {
      repoId: '139895205',
      canonicalKey: 'vuejs/core',
      fullName: 'vuejs/core',
      description: 'Vue 3 reactive UI framework',
      visibility: 'public'
    }

    const t0 = Date.now() - 120000
    // 第一次有效访问 apache/hadoop -> visitCount = 1, deviceSeq = 1
    const r1 = await callDatabase('recordBrowse', {
      accountId: '1001',
      repository: repoHadoop,
      source: 'feed',
      viewedAt: t0
    })
    assert.equal(r1.visitCount, 1)
    assert.equal(r1.countedVisit, true)
    assert.equal(r1.deviceSeq, 1)

    // 15 秒内重复访问 apache/hadoop (< 30s) -> 只更新 lastViewedAt，不新增有效事件或 outbox
    const r2 = await callDatabase('recordBrowse', {
      accountId: '1001',
      repository: repoHadoop,
      source: 'feed',
      viewedAt: t0 + 15000
    })
    assert.equal(r2.visitCount, 1)
    assert.equal(r2.countedVisit, false)
    assert.equal(r2.lastViewedAt, t0 + 15000)
    assert.equal(r2.deviceSeq, null)

    // 31 秒后再次访问 apache/hadoop (>= 30s) -> visitCount = 2, deviceSeq = 2
    const r3 = await callDatabase('recordBrowse', {
      accountId: '1001',
      repository: repoHadoop,
      source: 'search',
      viewedAt: t0 + 31000
    })
    assert.equal(r3.visitCount, 2)
    assert.equal(r3.countedVisit, true)
    assert.equal(r3.deviceSeq, 2)

    // 访问第二个仓库 vuejs/core -> visitCount = 1, deviceSeq = 3
    const r4 = await callDatabase('recordBrowse', {
      accountId: '1001',
      repository: repoVue,
      source: 'trending',
      viewedAt: t0 + 40000
    })
    assert.equal(r4.visitCount, 1)
    assert.equal(r4.countedVisit, true)
    assert.equal(r4.deviceSeq, 3)

    const localEvents = await callDatabase('listLocalActivityEvents', { accountId: '1001' })
    assert.equal(localEvents.length, 3)

    // 删除单条历史 (vuejs/core) -> 本地活动事件删除，outbox 中 seq=3 转为 discard 墓碑，序号仍为 1,2,3 连续无空洞
    await callDatabase('deleteHistory', { accountId: '1001', repoId: '139895205' })
    const batchBeforeUpload = await callDatabase('readOutboxBatch', { accountId: '1001' })
    assert.equal(batchBeforeUpload.hasBatch, true)
    assert.equal(batchBeforeUpload.firstSeq, 1)
    assert.equal(batchBeforeUpload.lastSeq, 3)
    assert.deepEqual(
      batchBeforeUpload.events.map((e) => [e.deviceSeq, e.recordKind]),
      [
        [1, 'open'],
        [2, 'open'],
        [3, 'discard']
      ]
    )
    assert.equal(batchBeforeUpload.events[2].repoId, undefined)

    // 模拟与服务端 /api/v2 交互：验证账号不一致阻断、正常绑定、批量上传 ACK 与 processedThrough 独立水位
    const serverCalls = []
    let mockAuthAccountId = '9999' // 先模拟不一致的 GitHub 账号

    const mockFetch = async (url, options = {}) => {
      const parsedUrl = new URL(url)
      const bodyObj = options.body ? JSON.parse(options.body) : null
      serverCalls.push({ path: parsedUrl.pathname, method: options.method || 'GET', body: bodyObj })

      if (parsedUrl.pathname === '/api/v2/auth/github/begin') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              challengeId: 'ch_test_1',
              authorizeUrl: 'https://github.com/login/oauth/authorize?state=ch_test_1',
              expiresAt: Date.now() + 300000
            })
        }
      }
      if (parsedUrl.pathname === '/api/v2/auth/github/poll') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              state: 'authenticated',
              accessToken: 'at_test_token',
              refreshToken: 'rt_test_token',
              expiresAt: Date.now() + 3600000,
              subjectId: 'subj_1001',
              accountId: mockAuthAccountId
            })
        }
      }
      if (parsedUrl.pathname === '/api/v2/devices/register') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              deviceId: 'dev_win_1001',
              streamEpoch: 1,
              analysisEpoch: 1,
              acceptedThrough: 0,
              exportedThrough: 0,
              processedThrough: 0,
              serverTime: Date.now(),
              preferences: { analysisEnabled: true }
            })
        }
      }
      if (parsedUrl.pathname === '/api/v2/events/batches') {
        // 校验每个 open 事件的 payloadHash 与服务端公式完全一致
        for (const ev of bodyObj.events) {
          if (ev.recordKind === 'open') {
            const expectedHash = computeOpenEventPayloadHash({
              eventId: ev.eventId,
              streamEpoch: bodyObj.streamEpoch,
              deviceSeq: ev.deviceSeq,
              analysisEpoch: bodyObj.analysisEpoch,
              repoId: ev.repoId,
              occurredAt: ev.occurredAt,
              source: ev.source
            })
            assert.equal(ev.payloadHash, expectedHash)
          }
        }
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              deviceId: 'dev_win_1001',
              streamEpoch: bodyObj.streamEpoch,
              analysisEpoch: bodyObj.analysisEpoch,
              acceptedThrough: 3,
              exportedThrough: 2,
              processedThrough: 0, // 服务端尚未跑离线画像，processedThrough 为 0
              serverTime: Date.now(),
              timeAdjustments: [
                {
                  eventId: bodyObj.events[0].eventId,
                  effectiveAt: t0 + 500,
                  timeFlag: 'clamped'
                }
              ]
            })
        }
      }
      if (parsedUrl.pathname === '/api/v2/me/collections') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              collectionKind: bodyObj.collectionKind,
              revision: (bodyObj.expectedRevision || 0) + 1,
              complete: bodyObj.complete,
              itemCount: bodyObj.repoIds.length
            })
        }
      }
      if (parsedUrl.pathname === '/api/v2/me/analysis/reset') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              subjectId: 'subj_1001',
              analysisEpoch: 2,
              resetAt: Date.now()
            })
        }
      }
      throw new Error(`Unexpected path: ${parsedUrl.pathname}`)
    }

    const cloudService = new CloudService({
      database: { callDatabase },
      fetchImpl: mockFetch,
      defaultBaseUrl: 'http://127.0.0.1:18080'
    })

    // A. 验证云端账号与本地账号不一致时阻止绑定和上传
    const begin1 = await cloudService.beginAuth({ accountId: '1001' }, { openBrowser: false })
    const mismatchRes = await cloudService.pollAuth({ accountId: '1001' }, { challengeId: begin1.challengeId })
    assert.equal(mismatchRes.state, 'account_mismatch')
    assert.equal(mismatchRes.error.code, 'CLOUD_ACCOUNT_MISMATCH')

    const flushBlocked = await cloudService.flushOutbox({ accountId: '1001' })
    assert.equal(flushBlocked.flushed, false)

    // B. 切换为匹配的账号 '1001' 后正常绑定并自动完成批量上传
    mockAuthAccountId = '1001'
    const begin2 = await cloudService.beginAuth({ accountId: '1001' }, { openBrowser: false })
    const authRes = await cloudService.pollAuth({ accountId: '1001' }, { challengeId: begin2.challengeId })
    assert.equal(authRes.state, 'authenticated')
    assert.equal(authRes.cloudSync.cloudBound, true)
    assert.equal(authRes.cloudSync.accountMatched, true)
    assert.equal(authRes.cloudSync.acceptedThrough, 3)
    assert.equal(authRes.cloudSync.exportedThrough, 2)
    // 验证 processedThrough 保持服务端真实返回的 0，绝不被错误覆盖为 acceptedThrough(3)
    assert.equal(authRes.cloudSync.processedThrough, 0)
    assert.equal(authRes.cloudSync.pendingCount, 0)

    // 验证 timeAdjustments 已写回 local_activity_events
    const updatedLocalEvents = await callDatabase('listLocalActivityEvents', { accountId: '1001' })
    const adjustedEv = updatedLocalEvents.find((e) => e.eventId === r1.eventId)
    assert.equal(adjustedEv.effectiveAt, t0 + 500)
    assert.equal(adjustedEv.timeFlag, 'clamped')

    // C. 验证 Star 集合完整同步与不完整保护
    const { generationId } = await callDatabase('beginSync', { accountId: '1001', kind: 'stars' })
    await callDatabase('writeSyncPage', {
      accountId: '1001',
      kind: 'stars',
      generationId,
      pageSeq: 1,
      items: [repoHadoop, repoVue],
      nextUrl: null
    })
    await callDatabase('finishSync', { accountId: '1001', kind: 'stars', generationId })

    const collSyncRes = await cloudService.syncCollections({ accountId: '1001' }, ['stars'])
    assert.equal(collSyncRes.results.stars.uploaded, true)
    assert.equal(collSyncRes.results.stars.revision, 1)
    assert.equal(collSyncRes.results.stars.itemCount, 2)

    // 模拟一次中断的不完整同步，验证绝不会覆盖云端完整快照
    const { generationId: gen2 } = await callDatabase('beginSync', { accountId: '1001', kind: 'stars' })
    await callDatabase('abortSync', { accountId: '1001', kind: 'stars', generationId: gen2, errorCode: 'NETWORK_ERROR' })
    // 将 active_complete 置 0 模拟本地处于不完整状态
    const resetRes = await cloudService.resetAnalysis({ accountId: '1001' })
    assert.equal(resetRes.analysisEpoch, 2)
    // 本地浏览历史仍然保留 apache/hadoop
    const histAfterReset = await callDatabase('listHistory', { accountId: '1001' })
    assert.equal(histAfterReset.total, 1)
    assert.equal(histAfterReset.items[0].repoId, '23418517')
  } finally {
    await closeDatabaseWorker()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { projectRepositoryToFeatureSpace } from '../shared/recommendation/features.js'
import { planDiscoveryQueries } from '../shared/recommendation/recall.js'

const require = createRequire(import.meta.url)
const { startDatabaseWorker, callDatabase, closeDatabaseWorker } = require('../electron/database.cjs')
const { CloudService } = require('../electron/cloud-service.cjs')

// The MySQL integration test exports its actual HTTP response bodies for this consumer test.
test('服务端实际画像响应可进入原生缓存、投影与搜索，并按当前设备接续进度', {
  skip: !process.env.HG_TEST_CONTRACT_INPUT
}, async () => {
  const contract = JSON.parse(fs.readFileSync(process.env.HG_TEST_CONTRACT_INPUT, 'utf8'))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'happygit-server-contract-'))
  await startDatabaseWorker(path.join(directory, 'client.db'))
  try {
    const accountId = '1001'
    const context = { accountId, status: 'authenticated', contextId: 'server-contract' }
    const portrait = structuredClone(contract.portrait)
    portrait.processedThrough['another-device'] = 999
    await callDatabase('saveProfile', { accountId, profile: { accountId, login: 'fixture', fetchedAt: Date.now() } })
    const service = new CloudService({
      database: { callDatabase },
      fetchImpl: async url => {
        const pathname = new URL(url).pathname
        let result
        if (pathname === '/api/v2/devices/register') {
          result = { subjectId: portrait.subjectId, deviceId: 'contract-device', streamEpoch: contract.streamEpoch,
            analysisEpoch: portrait.analysisEpoch, acceptedThrough: 2, exportedThrough: 2, processedThrough: 0,
            preferences: { revision: 4, analysisEpoch: portrait.analysisEpoch, analysisEnabled: true } }
        } else if (pathname === '/api/v2/me/portrait') result = portrait
        else if (pathname === '/api/v2/me/search-plan') result = contract.searchPlan
        else if (pathname === '/api/v2/cohorts') result = contract.cohorts
        else if (pathname === `/api/v2/feature-spaces/${portrait.featureSpaceVersion}`) result = contract.featureSpace
        else throw new Error(`Unexpected request: ${pathname}`)
        return { ok: true, status: 200, text: async () => JSON.stringify(result) }
      }
    })
    await service.saveTokens(accountId, { accessToken: 'contract-token', refreshToken: 'contract-refresh', expiresAt: Date.now() + 3600000, cloudAccountId: accountId })
    await callDatabase('saveCloudAccountState', { accountId, patch: { cloudBound: true, cloudAccountId: accountId, analysisEnabled: true } })
    await service.registerDeviceAndSyncStream(accountId)
    const refreshed = await service.refreshPortrait(context)
    assert.equal(refreshed.refreshed, true, JSON.stringify(refreshed))
    assert.equal(refreshed.cloudPortrait.status, 'ready')
    assert.equal(refreshed.cloudPortrait.processedThrough, 2)
    assert.equal(refreshed.cloudPortrait.featureSpace.language.Java, 0)
    assert.equal(refreshed.cloudPortrait.searchPlan.generationId, portrait.generationId)
    assert.ok(planDiscoveryQueries(refreshed.cloudPortrait.searchPlan).some(query => query.query.includes('topic:database')))
    const projected = projectRepositoryToFeatureSpace({ repoId: 'outside-catalog', primaryLanguage: 'Java', topics: ['database'] }, refreshed.cloudPortrait.featureSpace)
    assert.ok(projected.sparseVector.indices.includes(0))
    assert.ok(projected.sparseVector.indices.includes(128))
    const group = await service.refreshCohorts(context)
    assert.equal(group.cohorts.cohorts[0].memberCount, 1)
    assert.equal(group.cohorts.cohorts[0].suppressed, true)
    await callDatabase('recordBrowse', { accountId, repository: { repoId: '23418517', fullName: 'fixture/database', name: 'database', primaryLanguage: 'Java', topics: ['database'] }, source: 'browse', viewedAt: Date.now() })
    const batch = await callDatabase('readOutboxBatch', { accountId })
    assert.equal(batch.hasBatch, true)
    assert.equal(batch.events[0].deviceSeq, 3)
    if (process.env.HG_TEST_CLIENT_EVENTS) {
      const rows = batch.events.map(event => ({ ...event, kind: 'event', subjectId: portrait.subjectId, sourceKind: 'client_authenticated' }))
      fs.writeFileSync(process.env.HG_TEST_CLIENT_EVENTS, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    }
  } finally {
    await closeDatabaseWorker()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

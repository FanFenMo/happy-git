import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import db from '../electron/database.cjs'
import {
  buildReverseFeatureSpace,
  describeProjectKeywords,
  extractProjectKeywords,
  profileKeywordKeys
} from '../shared/recommendation/keywords.js'
import { buildInterestProfile } from '../shared/recommendation/profile.js'
import { createRecommendationBatch } from '../shared/recommendation/rank.js'

const project = {
  repoId: '12',
  name: 'vector-index',
  owner: 'fixture',
  fullName: 'fixture/vector-index',
  primaryLanguage: 'TypeScript',
  topics: ['retrieval', 'Retrieval'],
  description: 'Vector retrieval using fixture examples',
  updatedAt: Date.now()
}

test('local keyword weights merge structured metadata and TF-IDF without retaining noise', () => {
  const result = extractProjectKeywords({
    ...project,
    vector: { retrieval: 0.5, typescript: 0.4, github: 2, fixture: 1, 2026: 1, prototype: 0.1 }
  }, { manualTags: ['RETRIEVAL'] })
  assert.equal(result.sourceMode, 'local_tfidf')
  assert.deepEqual(result.items.map(item => item.canonical), ['typescript', 'retrieval', 'prototype'])
  assert.equal(result.items[0].weight, 1)
  assert.equal(result.items[0].term, 'TypeScript')
  assert.ok(Math.abs(result.items[1].rawWeight - 0.82) < 1e-9)
  assert.equal(result.items[1].source, 'mixed')
  assert.equal(result.items[1].matchedProfile, true)
  assert.ok(Math.abs(result.items.reduce((sum, item) => sum + item.sharePercent, 0) - 100) < 1e-9)
})

test('model keywords decode real coordinates and add bounded weights for novel metadata', () => {
  const featureSpace = {
    language: { TypeScript: 0 },
    topic: { retrieval: 1 },
    text: { vector: { index: 2, idf: 2 } }
  }
  const result = extractProjectKeywords({
    ...project,
    sparseVector: { indices: [0, 1, 2], values: [0.42, 0.55, 0.7] },
    projectionMeta: { missingFeatures: { unknownTopics: ['hnsw'] } }
  }, { reverseSpace: buildReverseFeatureSpace(featureSpace), userProfile: { languages: { TypeScript: 1 } } })
  assert.equal(result.sourceMode, 'feature_space')
  assert.deepEqual(result.items.slice(0, 3).map(item => [item.term, item.rawWeight, item.source]), [
    ['vector', 0.7, 'text'], ['retrieval', 0.55, 'topic'], ['TypeScript', 0.42, 'language']
  ])
  assert.equal(result.items[2].matchedProfile, true)
  assert.equal(result.items[3].term, 'hnsw')
  assert.ok(result.items[3].rawWeight <= (0.42 + 0.55 + 0.7) / 3 * 0.65)
})

test('legacy candidates use corpus IDF and report when the project has insufficient information', () => {
  const result = extractProjectKeywords({
    description: 'chromatic retrieval', purposeCue: 'chromatic retrieval'
  }, { corpusRepos: [{ description: 'retrieval storage' }, { description: 'retrieval cluster' }] })
  assert.equal(result.sourceMode, 'on_demand_fallback')
  assert.equal(result.items[0].term, 'chromatic')
  assert.ok(result.items[0].rawWeight > result.items[1].rawWeight)
  assert.deepEqual(extractProjectKeywords({ name: 'demo', description: 'github', primaryLanguage: '未标注' }).items, [])
  assert.equal(extractProjectKeywords({ primaryLanguage: 'Rust' }).insufficientText, true)
})

test('ranking stores compact keywords in both modes and resolves matches at display time', () => {
  const featureSpace = { language: { TypeScript: 0 }, topic: { retrieval: 1 }, text: { vector: { index: 2, idf: 2 } } }
  for (const [space, mode] of [[null, 'local_tfidf'], [featureSpace, 'feature_space']]) {
    const batch = createRecommendationBatch({
      accountId: '1',
      profile: buildInterestProfile({ accountId: '1', manualTags: ['TypeScript'] }),
      candidates: [{ ...project, topics: ['retrieval'] }],
      featureSpace: space
    })
    const { keywordWeights } = batch.items[0].repository
    assert.equal(keywordWeights.sourceMode, mode)
    assert.ok(keywordWeights.items.length <= 14)
    assert.ok(!JSON.stringify(keywordWeights).includes('matchedProfile'))
    const full = describeProjectKeywords(keywordWeights, 9, profileKeywordKeys(null, ['TypeScript']))
    assert.equal(full.items.find(item => item.canonical === 'typescript').matchedProfile, true)
  }
})

test('SQLite reads each account’s persisted profile, invalidates revisions and clears history evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happygit-local-profile-'))
  const path = join(directory, 'happygit.db')
  const call = db.callDatabase
  const accountId = '1001'
  const snapshot = () => call('readAccountSnapshot', { accountId })
  const savePortrait = async (id = accountId) => {
    const input = await call('createSnapshot', { accountId: id, purpose: 'profile' })
    const profile = buildInterestProfile(input)
    const result = await call('commitRecommendation', {
      accountId: id, purpose: 'profile', inputId: input.inputId, inputVersions: input.inputVersions, profile
    })
    assert.equal(result.ok, true)
    return profile
  }

  try {
    await db.startDatabaseWorker(path)
    for (const id of [accountId, '1002']) {
      await call('saveProfile', { accountId: id, profile: { accountId: id, login: `fixture-${id}` } })
    }
    assert.equal((await snapshot()).localProfile, null)
    await savePortrait('1002')
    await call('recordBrowse', { accountId, repository: project, source: 'trending', viewedAt: Date.now() })
    const expected = await savePortrait()
    await db.closeDatabaseWorker()
    await db.startDatabaseWorker(path)
    const cached = (await snapshot()).localProfile
    assert.deepEqual(cached.profile, JSON.parse(JSON.stringify(expected)))
    assert.equal(cached.modelVersion, 'content-v1')
    assert.ok(cached.generatedAt)
    assert.deepEqual(cached.inputVersions, expected.inputVersions)
    assert.equal(cached.stale, false)

    await call('savePreferences', { accountId, preferences: { manualTags: ['Rust'] } })
    assert.equal((await snapshot()).localProfile.stale, true)
    await savePortrait()
    await call('recordBrowse', {
      accountId, repository: { ...project, repoId: '14', fullName: 'fixture/other' }, source: 'trending', viewedAt: Date.now()
    })
    assert.equal((await snapshot()).localProfile.stale, true)
    await savePortrait()
    await call('applyConfirmedStar', { accountId, repository: project, starred: true })
    assert.equal((await snapshot()).localProfile.stale, true)
    await savePortrait()
    await call('recordRecommendationFeedback', { accountId, repoId: '14', kind: 'hide', eventId: 'hide-fixture' })
    assert.equal((await snapshot()).localProfile.stale, true)

    await call('savePreferences', { accountId, preferences: { historyEnabled: false } })
    assert.equal((await snapshot()).localProfile, null)
    const withoutHistory = await savePortrait()
    assert.ok(withoutHistory.evidenceRepos.every(repo => !repo.sources.includes('history')))
    assert.equal((await snapshot()).localProfile.stale, false)
    await call('savePreferences', { accountId, preferences: { historyEnabled: true } })
    await savePortrait()
    await call('deleteHistory', { accountId, repoId: project.repoId })
    assert.equal((await snapshot()).localProfile, null)
    await savePortrait()
    await call('clearHistory', { accountId })
    assert.equal((await snapshot()).localProfile, null)
    assert.equal((await call('readAccountSnapshot', { accountId: '1002' })).localProfile.profile.accountId, '1002')
  } finally {
    await db.closeDatabaseWorker()
    await rm(directory, { recursive: true, force: true })
  }
})

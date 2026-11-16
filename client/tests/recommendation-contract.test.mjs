import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import { buildVocabulary, extractRepositoryFeatures } from '../shared/recommendation/features.js'
import { buildInterestProfile } from '../shared/recommendation/profile.js'
import { planDiscoveryQueries } from '../shared/recommendation/recall.js'
import { scoreCandidate, rerankCandidates, createRecommendationBatch } from '../shared/recommendation/rank.js'

const require = createRequire(import.meta.url)
const db = require('../electron/database.cjs')

test('extractRepositoryFeatures preserves full Repository DTO fields alongside TF-IDF vector', () => {
  const sampleRepo = {
    repoId: '10270250',
    canonicalKey: 'facebook/react',
    owner: 'facebook',
    name: 'react',
    fullName: 'facebook/react',
    htmlUrl: 'https://github.com/facebook/react',
    description: 'The library for web and native user interfaces',
    readmeText: 'React lets you build user interfaces out of individual pieces called components.',
    primaryLanguage: 'JavaScript',
    topics: ['react', 'frontend', 'ui'],
    starCount: 225000,
    forkCount: 45000,
    visibility: 'public',
    isPrivate: false,
    isArchived: false,
    licenseSpdx: 'MIT',
    updatedAt: 1794000000000
  }

  const vocab = buildVocabulary([sampleRepo])
  const feat = extractRepositoryFeatures(sampleRepo, vocab)

  assert.equal(feat.repoId, '10270250')
  assert.equal(feat.canonicalKey, 'facebook/react')
  assert.equal(feat.owner, 'facebook')
  assert.equal(feat.name, 'react')
  assert.equal(feat.fullName, 'facebook/react')
  assert.equal(feat.htmlUrl, 'https://github.com/facebook/react')
  assert.equal(feat.description, sampleRepo.description)
  assert.equal(feat.licenseSpdx, 'MIT')
  assert.equal(feat.visibility, 'public')
  assert.ok(Object.keys(feat.vector).length > 0)
})

test('planDiscoveryQueries supports both array consumption and .queryPlan property', () => {
  const profile = buildInterestProfile({
    accountId: 'u1',
    starred: [
      {
        repoId: '1',
        canonicalKey: 'vuejs/core',
        fullName: 'vuejs/core',
         primaryLanguage: 'TypeScript',
        topics: ['vue', 'frontend', 'reactivity'],
        description: 'Vue 3 reactive framework'
      }
    ],
    manualTags: ['vite']
  })

  const plan = planDiscoveryQueries(profile, [], 1794096000000)
  assert.equal(Array.isArray(plan), true)
  assert.ok(plan.length > 0 && plan.length <= 4)
  assert.equal(Array.isArray(plan.queryPlan), true)
  assert.equal(plan.queryPlan.length, plan.length)
  assert.ok(plan[0].query.includes('archived:false is:public'))
})

test('buildInterestProfile and scoreCandidate share isomorphic text vectors', () => {
  const starredRepo = {
    repoId: '101',
    canonicalKey: 'apache/hadoop',
    owner: 'apache',
    name: 'hadoop',
    fullName: 'apache/hadoop',
    primaryLanguage: 'Java',
    topics: ['distributed-systems'],
    description: 'Apache Hadoop distributed storage hdfs and mapreduce cluster engine',
    readmeText: 'Hadoop HDFS NameNode DataNode MapReduce YARN distributed batch processing'
  }
  const matchingCandidate = {
    repoId: '202',
    canonicalKey: 'example/mr-toolkit',
    owner: 'example',
    name: 'mr-toolkit',
    fullName: 'example/mr-toolkit',
    primaryLanguage: 'Go',
    topics: ['cloud'],
    description: 'Toolkit for hdfs namenode datanode and mapreduce job diagnostics',
    readmeText: 'Monitor Hadoop HDFS blocks and MapReduce shuffle throughput',
    starCount: 600,
    updatedAt: 1794000000000
  }
  const unrelatedCandidate = {
    repoId: '203',
    canonicalKey: 'example/css-animations',
    owner: 'example',
    name: 'css-animations',
    fullName: 'example/css-animations',
    primaryLanguage: 'Go',
    topics: ['cloud'],
    description: 'Keyframe button hover effects and color gradients',
    readmeText: 'Pure CSS transitions for landing pages',
    starCount: 600,
    updatedAt: 1794000000000
  }

  const profile = buildInterestProfile({
    accountId: 'u1',
    starred: [starredRepo],
    candidates: [matchingCandidate, unrelatedCandidate],
    now: 1794096000000
  })

  assert.ok(profile.vector && Object.keys(profile.vector).length > 0)

  const matchRes = scoreCandidate(profile, matchingCandidate, 1794096000000, false)
  const unrelRes = scoreCandidate(profile, unrelatedCandidate, 1794096000000, false)

  assert.ok(matchRes.parts.textCosine > 0.25, `Expected positive textCosine, got ${matchRes.parts.textCosine}`)
  assert.equal(unrelRes.parts.textCosine, 0)
  assert.ok(matchRes.baseScore > unrelRes.baseScore)
})

test('rerankCandidates enforces MMR ordering, owner cap (<=2 in 10) and language cap (<=6 in 10) even when count <= limit', () => {
  const candidates = [
    // 4 repos from the same owner ' prolific ' with high scores
    { candidate: { repoId: '1', owner: 'prolific', fullName: 'prolific/r1', primaryLanguage: 'TypeScript', topics: ['a'] }, baseScore: 0.99 },
    { candidate: { repoId: '2', owner: 'prolific', fullName: 'prolific/r2', primaryLanguage: 'TypeScript', topics: ['b'] }, baseScore: 0.98 },
    { candidate: { repoId: '3', owner: 'prolific', fullName: 'prolific/r3', primaryLanguage: 'TypeScript', topics: ['c'] }, baseScore: 0.97 },
    { candidate: { repoId: '4', owner: 'prolific', fullName: 'prolific/r4', primaryLanguage: 'TypeScript', topics: ['d'] }, baseScore: 0.96 },
    // Other owners with TypeScript (to test language cap of 6 in 10)
    { candidate: { repoId: '5', owner: 'owner5', fullName: 'owner5/r5', primaryLanguage: 'TypeScript', topics: ['e'] }, baseScore: 0.95 },
    { candidate: { repoId: '6', owner: 'owner6', fullName: 'owner6/r6', primaryLanguage: 'TypeScript', topics: ['f'] }, baseScore: 0.94 },
    { candidate: { repoId: '7', owner: 'owner7', fullName: 'owner7/r7', primaryLanguage: 'TypeScript', topics: ['g'] }, baseScore: 0.93 },
    { candidate: { repoId: '8', owner: 'owner8', fullName: 'owner8/r8', primaryLanguage: 'TypeScript', topics: ['h'] }, baseScore: 0.92 },
    // Different languages with lower scores that must be promoted into top 10
    { candidate: { repoId: '9', owner: 'owner9', fullName: 'owner9/r9', primaryLanguage: 'Rust', topics: ['sys'] }, baseScore: 0.75 },
    { candidate: { repoId: '10', owner: 'owner10', fullName: 'owner10/r10', primaryLanguage: 'Python', topics: ['ml'] }, baseScore: 0.74 },
    { candidate: { repoId: '11', owner: 'owner11', fullName: 'owner11/r11', primaryLanguage: 'Go', topics: ['net'] }, baseScore: 0.73 },
    { candidate: { repoId: '12', owner: 'owner12', fullName: 'owner12/r12', primaryLanguage: 'Java', topics: ['db'] }, baseScore: 0.72 }
  ]

  // Pass intentionally unsorted input with length 12 <= limit 100
  const reversed = [...candidates].reverse()
  const ranked = rerankCandidates(reversed, 100, 42)
  assert.equal(ranked.length, 12)

  // First 10 items window checks
  const first10 = ranked.slice(0, 10)
  const prolificInFirst10 = first10.filter(x => x.candidate.owner === 'prolific').length
  const tsInFirst10 = first10.filter(x => x.candidate.primaryLanguage === 'TypeScript').length
  assert.ok(prolificInFirst10 <= 2, `Expected <= 2 from same owner in first 10, got ${prolificInFirst10}`)
  assert.ok(tsInFirst10 <= 6, `Expected <= 6 of same language in first 10 when other languages exist, got ${tsInFirst10}`)
})

test('native createSnapshot and commitRecommendation enforce snapshot identity and revision validation', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happygit-rec-contract-'))
  const dbPath = path.join(tempDir, 'happygit.db')
  await db.startDatabaseWorker(dbPath)

  try {
    await db.callDatabase('saveProfile', {
      accountId: '1001',
      profile: { accountId: '1001', login: 'alice', displayName: 'Alice' }
    })

    const snap = await db.callDatabase('createSnapshot', {
      accountId: '1001',
      purpose: 'profile',
      reason: 'unit_test'
    })
    assert.ok(snap.inputId)
    assert.equal(snap.accountId, '1001')

    // 1. Mutate history before committing snapshot -> must reject with INPUT_CHANGED
    await db.callDatabase('recordBrowse', {
      accountId: '1001',
      repository: {
        repoId: '9001',
        canonicalKey: 'vuejs/core',
        owner: 'vuejs',
        name: 'core',
        fullName: 'vuejs/core'
      },
      source: 'trending',
      viewedAt: Date.now()
    })

    const staleCommit = await db.callDatabase('commitRecommendation', {
      accountId: '1001',
      inputId: snap.inputId,
      inputVersions: snap.inputVersions,
      purpose: 'profile',
      profile: { accountId: '1001', languages: { TypeScript: 1 } }
    })
    assert.equal(staleCommit.ok, false)
    assert.equal(staleCommit.error, 'INPUT_CHANGED')

    // 2. Fresh snapshot commits cleanly once, and rejects duplicate/wrong-purpose reuse
    const freshSnap = await db.callDatabase('createSnapshot', {
      accountId: '1001',
      purpose: 'ranking',
      reason: 'unit_test'
    })
    const batch = createRecommendationBatch({
      batchId: 'batch_test_1',
      accountId: '1001',
      profile: { accountId: '1001', languages: { TypeScript: 1 }, topics: { vue: 1 } },
      candidates: [
        {
          repoId: '9002',
          canonicalKey: 'vitejs/vite',
          owner: 'vitejs',
          name: 'vite',
          fullName: 'vitejs/vite',
          htmlUrl: 'https://github.com/vitejs/vite',
          description: 'Next generation frontend tooling',
          primaryLanguage: 'TypeScript',
          topics: ['vite', 'vue'],
          starCount: 65000,
          updatedAt: Date.now()
        }
      ],
      inputVersions: freshSnap.inputVersions
    })

    const okCommit = await db.callDatabase('commitRecommendation', {
      accountId: '1001',
      inputId: freshSnap.inputId,
      inputVersions: freshSnap.inputVersions,
      purpose: 'ranking',
      batch
    })
    assert.equal(okCommit.ok, true)

    const listed = await db.callDatabase('listRecommendation', {
      accountId: '1001',
      batchId: 'batch_test_1',
      offset: 0,
      limit: 20
    })
    assert.equal(listed.total, 1)
    assert.equal(listed.items[0].repoId, '9002')
    assert.equal(listed.items[0].repository.fullName, 'vitejs/vite')
    assert.equal(listed.items[0].repository.owner, 'vitejs')

    // Reusing consumed snapshot must be rejected
    const replayCommit = await db.callDatabase('commitRecommendation', {
      accountId: '1001',
      inputId: freshSnap.inputId,
      inputVersions: freshSnap.inputVersions,
      purpose: 'ranking',
      batch
    })
    assert.equal(replayCommit.ok, false)
    assert.equal(replayCommit.error, 'INPUT_CHANGED')
  } finally {
    await db.closeDatabaseWorker()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

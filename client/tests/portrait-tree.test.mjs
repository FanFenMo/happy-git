import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPersonalPortraitModel } from '../src/models/portrait-tree.js'
import { normalizeProfile } from '../shared/github-page/normalize.js'

test('buildPersonalPortraitModel 优先展示云端模型画像并生成树状图、雷达图与星图节点', () => {
  const model = buildPersonalPortraitModel({
    profile: { displayName: 'FanFenMo', login: 'FanFenMo' },
    cloudPortrait: {
      status: 'ready',
      modelVersion: 'portrait-101f749d459768596fbb3275',
      generationId: 'gen-live-abc123',
      generatedAt: 1795840000000,
      portrait: {
        languages: { Python: 0.45, TypeScript: 0.35, Go: 0.2 },
        topics: { llm: 0.5, rag: 0.3, distributed: 0.2 },
        directions: [
          {
            directionId: 'direction-02',
            label: 'Python · llm 方向',
            weight: 0.68,
            languages: ['Python'],
            topics: ['llm', 'rag'],
            evidenceRepos: ['owner/rag-engine']
          }
        ],
        topInterests: [{ tag: 'llm', score: 0.92, evidenceRepos: ['owner/rag-engine'] }],
        evidenceRepos: [
          { repoId: '101', fullName: 'owner/rag-engine', primaryLanguage: 'Python', sources: ['star', 'owned'], weight: 4.5 }
        ]
      }
    }
  })

  assert.equal(model.sourceKind, 'cloud')
  assert.equal(model.modelVersion, 'portrait-101f749d459768596fbb3275')
  assert.equal(model.branches.length, 4)
  assert.equal(model.branches[0].id, 'directions')
  assert.equal(model.branches[0].children[0].label, 'Python · llm 方向')
  assert.ok(model.radarAxes.length >= 3)
  assert.ok(model.constellationNodes.length >= 4)
})

test('buildPersonalPortraitModel 在无云端画像时基于本机仓库生成树状图，并在无证据时保持空', () => {
  const localOnly = buildPersonalPortraitModel({
    profile: { login: 'FanFenMo' },
    repos: [
      { fullName: 'FanFenMo/happy-git', primaryLanguage: 'Vue', description: 'Open source project recommendation with Hadoop', topics: ['hadoop'] }
    ],
    manualTags: ['Vue']
  })
  assert.equal(localOnly.sourceKind, 'local')
  assert.ok(localOnly.branches.some(b => b.id === 'languages' && b.children[0].label === 'Vue'))
  assert.ok(localOnly.branches.some(b => b.id === 'evidence' && b.children[0].fullName === 'FanFenMo/happy-git'))

  const empty = buildPersonalPortraitModel({ profile: { login: 'guest' } })
  assert.equal(empty.sourceKind, 'empty')
  assert.equal(empty.branches.length, 0)
})

test('normalizeProfile 自动剥离 GitHub 个人页昵称中的代词后缀', () => {
  const normalized = normalizeProfile({
    accountId: '210000727',
    login: 'FanFenMo · he/him',
    displayName: 'FanFenMo'
  })
  assert.equal(normalized.login, 'FanFenMo')
  assert.equal(normalized.profileUrl, 'https://github.com/FanFenMo')
})

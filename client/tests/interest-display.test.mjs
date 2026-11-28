import assert from 'node:assert/strict'
import test from 'node:test'
import { formatShare, keywordBubbleScale, projectKeywords } from '../src/models/interest-display.js'

const keywordWeights = {
  sourceMode: 'feature_space',
  totalTermsConsidered: 30,
  items: [['profiling', 1, 'text'], ['Rust', 3, 'language'], ['observability', 2, 'topic'], ['坏数据', NaN, 'topic'], ['空权重', 0, 'topic']]
}

test('关键词使用推荐批次的真实权重，只用展示词计算占比', () => {
  const result = projectKeywords({ keywordWeights })
  assert.equal(result.sourceMode, 'feature_space')
  assert.equal(result.totalTermsConsidered, 30)
  assert.deepEqual(result.items.map(({ term, rawWeight, source }) => [term, rawWeight, source]), [
    ['Rust', 3, 'language'], ['observability', 2, 'topic'], ['profiling', 1, 'text']
  ])
  assert.deepEqual(result.items.map(({ sharePercent }) => formatShare(sharePercent)), ['50%', '33.3%', '16.7%'])
  assert.equal(result.items[0].weight, 1)
  assert.deepEqual(keywordWeights.items[0], ['profiling', 1, 'text'])
})

test('没有保存权重的旧项目按公开资料提取，资料不足时不伪造数据', () => {
  const legacy = projectKeywords({ fullName: 'owner/event-index', description: 'Streaming telemetry', primaryLanguage: 'Go' })
  assert.equal(legacy.sourceMode, 'on_demand_fallback')
  assert.ok(legacy.items.some(item => item.term === 'telemetry'))
  assert.deepEqual(projectKeywords({ name: 'demo', description: 'open source', primaryLanguage: '未标注' }).items, [])
})

test('气泡大小随权重上升，保留小权重气泡的文字空间', () => {
  const scales = [0, .01, .1, .5, 1].map(keywordBubbleScale)
  assert.ok(scales.every((scale, index) => index === 0 || scale > scales[index - 1]))
  assert.equal(scales[0], .56)
  assert.equal(scales.at(-1), 1)
  assert.equal(formatShare(.012), '<0.1%')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { run as runSearch } from '../shared/github-page/scripts/readSearchResults.js'
import { run as runDetail } from '../shared/github-page/scripts/readRepositoryDetail.js'
import { parseGitHubSearchHtml } from '../shared/github-page/search-html-parser.js'

const require = createRequire(import.meta.url)
const { IpcRouter } = require('../electron/ipc-router.cjs')
const { PageTaskScheduler } = require('../electron/task-scheduler.cjs')

const clientDir = fileURLToPath(new URL('..', import.meta.url))

function createMockElement({
  tag = 'div',
  attrs = {},
  classes = [],
  text = '',
  children = [],
  closestMatch = null
} = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    innerText: text,
    textContent: text,
    classList: {
      contains: (c) => classes.includes(c)
    },
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    hasAttribute: (name) => Object.prototype.hasOwnProperty.call(attrs, name),
    closest: (selector) => (closestMatch && selector.includes(closestMatch) ? {} : null),
    querySelector: (selector) => el.querySelectorAll(selector)[0] || null,
    querySelectorAll: (selector) => {
      const selectors = selector.split(',').map((s) => s.trim())
      const matched = []
      for (const child of children) {
        for (const s of selectors) {
          if (child._matches && child._matches.includes(s)) {
            matched.push(child)
            break
          }
        }
      }
      return matched
    }
  }
  return el
}

test('readSearchResults extracts React search card description/language/topics and ignores Sponsor popover <p>', () => {
  const titleSpan = createMockElement({
    tag: 'span',
    text: 'vinta/awesome-python',
    closestMatch: 'h3'
  })
  titleSpan._matches = ['.search-match']

  const titleLink = createMockElement({
    tag: 'a',
    attrs: { href: '/vinta/awesome-python' },
    text: 'vinta/awesome-python'
  })
  titleLink._matches = ['.search-title a', 'h3 a', 'a[href*="/"]']

  const descSpan = createMockElement({
    tag: 'span',
    text: 'An opinionated list of awesome Python frameworks, libraries, software and resources.'
  })
  descSpan._matches = ['.search-match']

  const sponsorP = createMockElement({
    tag: 'p',
    text: 'Learn more about funding links in repositories.'
  })
  sponsorP._matches = ['p']

  const langSpan = createMockElement({
    tag: 'span',
    attrs: { 'aria-label': 'Python language' },
    text: 'Python'
  })
  langSpan._matches = ['span[aria-label$=" language"]']

  const starLink = createMockElement({
    tag: 'a',
    attrs: { href: '/vinta/awesome-python/stargazers', 'aria-label': '337000 stars' },
    text: '337k'
  })
  starLink._matches = ['a[href*="/stargazers"]']

  const topic1 = createMockElement({ tag: 'a', attrs: { href: '/topics/python' }, text: 'python' })
  topic1._matches = ['a[href^="/topics/"]']
  const topic2 = createMockElement({ tag: 'a', attrs: { href: '/topics/awesome' }, text: 'awesome' })
  topic2._matches = ['a[href^="/topics/"]']

  const card1 = createMockElement({
    classes: ['Result__Of4h7n'],
    children: [titleLink, titleSpan, descSpan, sponsorP, langSpan, starLink, topic1, topic2]
  })
  card1._matches = ['[data-testid="results-list"] > div']

  // Card 2: no description on DOM, only a sponsor <p> — must NOT pick up sponsor <p>
  const card2Title = createMockElement({
    tag: 'a',
    attrs: { href: '/owner/no-desc-repo' },
    text: 'owner/no-desc-repo'
  })
  card2Title._matches = ['.search-title a', 'h3 a', 'a[href*="/"]']
  const card2SponsorP = createMockElement({
    tag: 'p',
    text: 'Learn more about funding links in repositories.'
  })
  card2SponsorP._matches = ['p']
  const card2 = createMockElement({
    classes: ['Result__Of4h7n'],
    children: [card2Title, card2SponsorP]
  })
  card2._matches = ['[data-testid="results-list"] > div']

  const embeddedScript = createMockElement({
    tag: 'script',
    attrs: { type: 'application/json', 'data-target': 'react-app.embeddedData' },
    text: JSON.stringify({
      payload: {
        blackbirdSearchRoute: {
          results: [
            {
              id: '21289110',
              hl_name: 'vinta/<em>awesome-python</em>',
              hl_trunc_description: 'An opinionated list of awesome Python frameworks, libraries, software and resources.',
              language: 'Python',
              followers: 337123,
              topics: ['python', 'awesome', 'collections'],
              repo: { repository: { id: 21289110, owner_login: 'vinta', name: 'awesome-python', updated_at: '2026-11-20T01:02:03Z' } }
            }
          ]
        }
      }
    })
  })
  embeddedScript._matches = ['script[type="application/json"]']

  const doc = createMockElement({
    children: [embeddedScript, card1, card2]
  })
  doc.body = { innerText: '' }

  const out = runSearch(doc, { pageSeq: 1 })
  assert.equal(out.items.length, 2)
  assert.equal(out.items[0].fullName, 'vinta/awesome-python')
  assert.equal(out.items[0].repoId, '21289110')
  assert.equal(out.items[0].description, 'An opinionated list of awesome Python frameworks, libraries, software and resources.')
  assert.equal(out.items[0].primaryLanguage, 'Python')
  assert.equal(out.items[0].starCount, '337123')
  assert.deepEqual(out.items[0].topics, ['python', 'awesome', 'collections'])
  assert.equal(out.items[0].updatedAt, '2026-11-20T01:02:03Z')

  assert.equal(out.items[1].fullName, 'owner/no-desc-repo')
  assert.equal(out.items[1].description, null)
})

test('readRepositoryDetail extracts description, topics, stars, and license from React sidebarAboutData', () => {
  const embedded = createMockElement({
    tag: 'script',
    attrs: { type: 'application/json', 'data-target': 'react-app.embeddedData' },
    text: JSON.stringify({
      payload: {
        codeViewOverviewRoute: {
          sidebarAboutData: {
            ownerLogin: 'farion1231',
            repoName: 'cc-switch',
            description: 'A cross-platform desktop All-in-One assistant.',
            topics: [{ name: 'rust' }, { name: 'mcp' }],
            stargazerCount: 156536,
            forksCount: 10225,
            repo: { id: 1031912724, license: { spdxId: 'MIT' } }
          }
        }
      }
    })
  })
  embedded._matches = ['script[type="application/json"]']

  const doc = createMockElement({ children: [embedded] })
  const detail = runDetail(doc, { expectedFullName: 'farion1231/cc-switch' })
  assert.equal(detail.repoId, '1031912724')
  assert.equal(detail.description, 'A cross-platform desktop All-in-One assistant.')
  assert.deepEqual(detail.topics, ['rust', 'mcp'])
  assert.equal(detail.starCount, '156536')
  assert.equal(detail.forkCount, '10225')
  assert.equal(detail.licenseSpdx, 'MIT')
})

test('built Android page-scripts.json strips export keyword and compiles cleanly as JS', () => {
  const jsonPath = path.join(clientDir, 'android/app/src/main/assets/happygit/page-scripts.json')
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  const scripts = parsed.scripts || {}
  assert.ok(Object.keys(scripts).length >= 10)
  for (const [id, code] of Object.entries(scripts)) {
    assert.equal(/^\s*export\s+/m.test(code), false, `${id} still contains export`)
    const runnable = code.replace('%ARGS%', '{}')
    // Must parse as valid classic JS without SyntaxError
    assert.doesNotThrow(() => new Function(runnable), `${id} failed JS syntax compile`)
  }
})

test('parseGitHubSearchHtml parses blackbirdSearchRoute embeddedData, decodes entities, and handles rate-limit/fallback', () => {
  const sampleHtml = `<!doctype html><html><head><title>Repository search results</title></head><body>
    <script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({
      payload: {
        blackbirdSearchRoute: {
          page_count: 12,
          result_count: 3456,
          results: [
            {
              id: '1031912724',
              hl_name: 'farion1231/<em>cc-switch</em>',
              hl_trunc_description: 'Fast &amp; reliable <em>Rust</em> assistant &#39;all-in-one&#39;.',
              language: 'Rust',
              followers: 156536,
              topics: ['rust', 'mcp'],
              repo: { repository: { id: 1031912724, owner_login: 'farion1231', name: 'cc-switch', updated_at: '2026-11-23T08:00:00Z' } }
            }
          ]
        }
      }
    })}</script></body></html>`

  const parsed = parseGitHubSearchHtml(sampleHtml, {
    pageSeq: 1,
    requestUrl: 'https://github.com/search?q=rust&type=repositories&s=stars&o=desc&p=1'
  })
  assert.ok(parsed)
  assert.equal(parsed.rateLimited, false)
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].fullName, 'farion1231/cc-switch')
  assert.equal(parsed.items[0].description, "Fast & reliable Rust assistant 'all-in-one'.")
  assert.equal(parsed.items[0].primaryLanguage, 'Rust')
  assert.equal(parsed.items[0].starCount, '156536')
  assert.deepEqual(parsed.items[0].topics, ['rust', 'mcp'])
  assert.equal(parsed.resultCount, 3456)
  assert.ok(parsed.nextUrl.includes('p=2'))

  const rateLimited = parseGitHubSearchHtml('<html><head><title>Whoa there!</title></head></html>')
  assert.equal(rateLimited.rateLimited, true)

  const unknown = parseGitHubSearchHtml('<html><head><title>Sign in</title></head><body>login</body></html>')
  assert.equal(unknown, null)
})

test('IpcRouter runs personalized search concurrently, hits discovery_cache on repeat, and falls back to browser when fast fetch returns null', async () => {
  const cacheStore = new Map()
  let fastCalls = 0
  let browserCalls = 0
  let inFlight = 0
  let maxConcurrent = 0

  const router = new IpcRouter({
    sessionManager: { getContext: () => ({ contextId: 'ctx_1', accountId: 'acc_1', status: 'authenticated' }) },
    accountSyncService: {},
    starService: {},
    database: {
      callDatabase: async (action, payload) => {
        if (action === 'readDiscoveryCache') {
          return cacheStore.get(`${payload.accountId}:${payload.queryKey}`) || null
        }
        if (action === 'saveDiscoveryCache') {
          cacheStore.set(`${payload.accountId}:${payload.queryKey}`, {
            items: JSON.parse(payload.resultJson),
            fetchedAt: payload.fetchedAt
          })
          return { saved: true }
        }
        return null
      }
    },
    browser: { getOrCreateWorkPage: () => ({ webContents: {} }) },
    scheduler: { enqueue: async ({ taskFn }) => taskFn() },
    fastSearchFetcher: async (url) => {
      fastCalls += 1
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise((r) => setTimeout(r, 25))
      inFlight -= 1
      if (url.includes('fallback')) return null
      const q = new URL(url).searchParams.get('q')
      return {
        items: [{ repoId: `id_${q}`, canonicalKey: `org/${q}`, fullName: `org/${q}`, description: `desc ${q}` }],
        nextUrl: `${url}&p=2`
      }
    },
    pageExecutorFactory: () => ({
      runTask: async ({ url }) => {
        browserCalls += 1
        return {
          items: [{ repoId: 'id_fb', canonicalKey: 'org/fallback', fullName: 'org/fallback', description: 'from browser' }],
          nextUrl: null
        }
      }
    }),
    routes: {
      searchRepositoriesUrl: (q, sort, page) => `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories&s=${sort}&p=${page}`
    }
  })

  const plan = [
    { id: 'q1', query: 'topic_a', sort: 'stars', startPage: 1, maxPages: 1 },
    { id: 'q2', query: 'topic_b', sort: 'stars', startPage: 1, maxPages: 1 },
    { id: 'q3', query: 'topic_c', sort: 'stars', startPage: 1, maxPages: 1 },
    { id: 'q4', query: 'fallback', sort: 'stars', startPage: 1, maxPages: 1 }
  ]

  // Round 1: cache miss -> 4 concurrent fast calls, 1 falls back to browser
  const r1 = await router.handleInvoke(null, {
    operation: 'discovery.refresh',
    contextId: 'ctx_1',
    payload: { mode: 'personalized', queryPlan: plan }
  })
  assert.equal(r1.ok, true)
  assert.equal(r1.data.count, 4)
  assert.equal(fastCalls, 4)
  assert.equal(browserCalls, 1)
  assert.ok(maxConcurrent >= 2, `expected concurrent search execution, got maxConcurrent=${maxConcurrent}`)

  // Round 2: normal refresh -> 100% cache hit, 0 new network calls
  const r2 = await router.handleInvoke(null, {
    operation: 'discovery.refresh',
    contextId: 'ctx_1',
    payload: { mode: 'personalized', queryPlan: plan, forceRefresh: false }
  })
  assert.equal(r2.ok, true)
  assert.equal(r2.data.count, 4)
  assert.equal(fastCalls, 4)
  assert.equal(browserCalls, 1)

  // Round 3: forceRefresh=true -> bypasses cache and re-fetches
  const r3 = await router.handleInvoke(null, {
    operation: 'discovery.refresh',
    contextId: 'ctx_1',
    payload: { mode: 'personalized', queryPlan: plan, forceRefresh: true }
  })
  assert.equal(r3.ok, true)
  assert.equal(fastCalls, 8)
  assert.equal(browserCalls, 2)
})

test('IpcRouter runs interactive GitHub search for guests and users via local search engine without polluting discovery_cache', async () => {
  let currentContext = { contextId: 'guest_1', accountId: null, status: 'guest' }
  const cacheWrites = []
  const fetchedUrls = []
  let browserCalls = 0
  const searchRoutes = await import('../shared/github-page/routes.js')

  const router = new IpcRouter({
    sessionManager: { getContext: () => currentContext },
    accountSyncService: {},
    starService: {},
    database: {
      callDatabase: async (action, payload) => {
        if (action === 'saveDiscoveryCache') {
          cacheWrites.push(payload)
        }
        return null
      }
    },
    browser: { getOrCreateWorkPage: () => ({ webContents: {} }) },
    scheduler: { enqueue: async ({ taskFn }) => taskFn() },
    fastSearchFetcher: async (url) => {
      fetchedUrls.push(url)
      if (url.includes('rate_limit_trigger')) {
        const err = new Error('RATE_LIMITED')
        err.code = 'RATE_LIMITED'
        throw err
      }
      if (url.includes('browser_fallback')) {
        return null
      }
      return {
        items: [
          { repoId: '101', canonicalKey: 'org/alpha', fullName: 'org/alpha', description: 'alpha' },
          { repoId: '101', canonicalKey: 'org/alpha', fullName: 'org/alpha', description: 'alpha dup' },
          { repoId: '102', canonicalKey: 'org/beta', fullName: 'org/beta', description: 'beta' }
        ],
        nextUrl: 'https://github.com/search?q=mcp&type=repositories&p=2',
        completion: 'more',
        pageCount: 5,
        resultCount: 1280
      }
    },
    pageExecutorFactory: () => ({
      runTask: async ({ scriptId, url, args }) => {
        browserCalls += 1
        assert.equal(scriptId, 'readSearchResults')
        assert.equal(args.pageSeq, 2)
        assert.ok(url.includes('s=forks'))
        return {
          items: [
            { repoId: '201', canonicalKey: 'org/fallback-repo', fullName: 'org/fallback-repo', description: 'via browser' }
          ],
          nextUrl: null,
          completion: 'end'
        }
      }
    }),
    routes: searchRoutes
  })

  // 1. Blank query returns empty immediately without hitting network or cache
  const emptyRes = await router.handleInvoke(null, {
    operation: 'discovery.refresh',
    contextId: 'guest_1',
    payload: { mode: 'search', query: '   ', sort: 'stars', page: 1 }
  })
  assert.equal(emptyRes.ok, true)
  assert.equal(emptyRes.data.count, 0)
  assert.deepEqual(emptyRes.data.items, [])
  assert.equal(fetchedUrls.length, 0)

  // 2. Guest search with Best Match (sort: '') hits fastSearchFetcher, omits s/o params, deduplicates items, never writes discovery_cache
  const guestRes = await router.handleInvoke(null, {
    operation: 'discovery.refresh',
    contextId: 'guest_1',
    payload: { mode: 'search', query: 'mcp server language:Rust', sort: '', page: 1 }
  })
  assert.equal(guestRes.ok, true)
  assert.equal(guestRes.data.count, 2)
  assert.equal(guestRes.data.hasMore, true)
  assert.equal(guestRes.data.nextPage, 2)
  assert.equal(guestRes.data.pageCount, 5)
  assert.equal(guestRes.data.resultCount, 1280)
  assert.equal(fetchedUrls.length, 1)
  assert.equal(new URL(fetchedUrls[0]).searchParams.has('s'), false)
  assert.equal(cacheWrites.length, 0)

  // 3. Authenticated user search falling back to hidden browser when fastSearchFetcher returns null
  currentContext = { contextId: 'ctx_1', accountId: 'acc_1', status: 'authenticated' }
  const fallbackRes = await router.handleInvoke(null, {
    operation: 'discovery.refresh',
    contextId: 'ctx_1',
    payload: { mode: 'search', query: 'browser_fallback', sort: 'forks', page: 2 }
  })
  assert.equal(fallbackRes.ok, true)
  assert.equal(browserCalls, 1)
  assert.equal(fallbackRes.data.count, 1)
  assert.equal(fallbackRes.data.hasMore, false)
  assert.equal(fallbackRes.data.nextPage, null)
  assert.equal(cacheWrites.length, 0)

  // 4. Rate limit propagates cleanly
  const limitRes = await router.handleInvoke(null, {
    operation: 'discovery.refresh',
    contextId: 'ctx_1',
    payload: { mode: 'search', query: 'rate_limit_trigger', sort: 'updated', page: 1 }
  })
  assert.equal(limitRes.ok, false)
  assert.equal(limitRes.error.code, 'RATE_LIMITED')
})

test('PageTaskScheduler wakes queued tasks after page lease finishes and maintains mutual exclusion', async () => {
  const scheduler = new PageTaskScheduler()
  scheduler.minIntervalMs = 0

  const timeline = []
  let active = 0
  let overlapDetected = false

  const track = async (label, ms) => {
    active += 1
    if (active > 1) overlapDetected = true
    timeline.push(`${label}:start`)
    await new Promise((r) => setTimeout(r, ms))
    timeline.push(`${label}:end`)
    active -= 1
    return label
  }

  // Case 1: lease holds lock while higher/lower priority tasks enqueue
  const pLease = scheduler.withPageLease({ contextId: 'ctx_1' }, 'verify', () => track('lease1', 25))
  const pSync = scheduler.enqueue({ taskId: 'sync_1', contextId: 'ctx_1', kind: 'sync', taskFn: () => track('sync1', 10) })
  const pTrend = scheduler.enqueue({ taskId: 'trend_1', contextId: 'ctx_1', kind: 'trending', taskFn: () => track('trend1', 10) })

  const results1 = await Promise.all([pLease, pSync, pTrend])
  assert.deepEqual(results1, ['lease1', 'sync1', 'trend1'])
  assert.equal(overlapDetected, false)
  assert.deepEqual(timeline, [
    'lease1:start', 'lease1:end',
    'trend1:start', 'trend1:end',
    'sync1:start', 'sync1:end'
  ])

  // Case 2: queued task holds lock while lease is requested -> lease waits for currentTask then runs before lower priority tasks
  timeline.length = 0
  const pTask = scheduler.enqueue({ taskId: 'task_2', contextId: 'ctx_1', kind: 'sync', taskFn: () => track('task2', 25) })
  await new Promise((r) => setImmediate(r))
  const pLease2 = scheduler.withPageLease({ contextId: 'ctx_1' }, 'verify', () => track('lease2', 10))
  const pSync2 = scheduler.enqueue({ taskId: 'sync_2', contextId: 'ctx_1', kind: 'sync', taskFn: () => track('sync2', 10) })

  const results2 = await Promise.all([pTask, pLease2, pSync2])
  assert.deepEqual(results2, ['task2', 'lease2', 'sync2'])
  assert.equal(overlapDetected, false)
  assert.deepEqual(timeline, [
    'task2:start', 'task2:end',
    'lease2:start', 'lease2:end',
    'sync2:start', 'sync2:end'
  ])
})

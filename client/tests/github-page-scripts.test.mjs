import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run as runSearch } from '../shared/github-page/scripts/readSearchResults.js'
import { run as runDetail } from '../shared/github-page/scripts/readRepositoryDetail.js'

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

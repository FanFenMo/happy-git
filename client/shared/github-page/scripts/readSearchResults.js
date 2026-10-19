/**
 * readSearchResults.js
 * 从 GitHub 搜索页面提取仓库搜索候选条目及翻页信息 (依据 project.md 第六节)
 */

export function run(doc, args = {}) {
  const pageSeq = args.pageSeq || 1

  const rows = Array.from(doc.querySelectorAll('.repo-list-item, [data-testid="results-list"] > div, .search-title a'))
  const blankslate = doc.querySelector('.blankslate') || doc.body?.innerText?.includes('We couldn’t find any repositories')

  if (rows.length === 0 && blankslate) {
    return {
      items: [],
      nextUrl: null,
      completion: 'end',
      pageSeq
    }
  }

  const items = []
  const seenKeys = new Set()

  const resultCards = Array.from(doc.querySelectorAll('.repo-list-item, [data-testid="results-list"] > div'))

  for (const card of resultCards) {
    const titleLink = card.querySelector('a.v-align-middle') || card.querySelector('h3 a') || card.querySelector('a[href*="/"]')
    if (!titleLink) continue

    const href = titleLink.getAttribute('href') || ''
    const cleanHref = href.replace(/^\//, '').split('?')[0]
    if (!cleanHref || !cleanHref.includes('/') || cleanHref.startsWith('search')) continue

    const parts = cleanHref.split('/')
    if (parts.length < 2) continue

    const fullName = `${parts[0]}/${parts[1]}`
    if (seenKeys.has(fullName.toLowerCase())) continue
    seenKeys.add(fullName.toLowerCase())

    const descEl = card.querySelector('p') || card.querySelector('.mb-1')
    const langEl = card.querySelector('[itemprop="programmingLanguage"]') || card.querySelector('span.color-fg-muted')
    const starEl = card.querySelector('a[href*="/stargazers"]')
    const timeEl = card.querySelector('relative-time') || card.querySelector('time')

    const topicEls = Array.from(card.querySelectorAll('a.topic-tag, [data-ga-click*="topic"]'))
    const topics = topicEls.map(el => el.innerText.trim().replace(/^#/, '')).filter(Boolean)

    items.push({
      fullName,
      owner: parts[0],
      name: parts[1],
      htmlUrl: `https://github.com/${fullName}`,
      description: descEl?.innerText?.trim() || null,
      primaryLanguage: langEl?.innerText?.trim() || null,
      starCount: starEl?.innerText?.trim() || null,
      topics,
      updatedAt: timeEl?.getAttribute('datetime') || null
    })
  }

  // 翻页链接
  const nextBtn = doc.querySelector('a.next_page')
    || doc.querySelector('a[rel="next"]')
    || Array.from(doc.querySelectorAll('.paginate-container a, nav[aria-label="Pagination"] a')).find(a => a.innerText.includes('Next'))

  let nextUrl = null
  let completion = 'end'

  if (nextBtn && !nextBtn.hasAttribute('disabled') && !nextBtn.classList.contains('disabled')) {
    const rawHref = nextBtn.getAttribute('href')
    if (rawHref) {
      nextUrl = new URL(rawHref, 'https://github.com').toString()
      completion = 'more'
    }
  }

  return {
    items,
    nextUrl,
    completion,
    pageSeq
  }
}

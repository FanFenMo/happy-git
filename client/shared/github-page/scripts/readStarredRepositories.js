/**
 * readStarredRepositories.js
 * 从用户的 Star 页面提取公开收藏仓库条目及翻页信息 (依据 project.md 第六节)
 */

export function run(doc, args = {}) {
  const pageSeq = args.pageSeq || 1

  // 定位主 Star 列表条目容器（排除自建列表 Lists）
  const listItems = Array.from(doc.querySelectorAll('#user-starred-repos .col-12.d-block, [data-filterable-for="your-stars-filter"] > div, .Box-row'))
  const blankslate = doc.querySelector('.blankslate')

  if (listItems.length === 0 && blankslate) {
    return {
      items: [],
      nextUrl: null,
      completion: 'end',
      pageSeq
    }
  }

  const items = []

  for (const row of listItems) {
    const titleLink = row.querySelector('h3 a') || row.querySelector('a[itemprop="name codeRepository"]')
    if (!titleLink) continue

    const href = titleLink.getAttribute('href') || ''
    const fullName = href.replace(/^\//, '').split('?')[0]
    if (!fullName || !fullName.includes('/')) continue

    const parts = fullName.split('/')
    const owner = parts[0]
    const name = parts[1]

    const descEl = row.querySelector('p') || row.querySelector('.description')
    const langEl = row.querySelector('[itemprop="programmingLanguage"]')
    const starCountEl = row.querySelector('a[href*="/stargazers"]')
    const forkCountEl = row.querySelector('a[href*="/forks"]')
    const timeEl = row.querySelector('relative-time') || row.querySelector('time')

    // Topics 标签
    const topicEls = Array.from(row.querySelectorAll('a.topic-tag, [data-ga-click*="topic"]'))
    const topics = topicEls.map(el => el.innerText.trim().replace(/^#/, '')).filter(Boolean)

    items.push({
      fullName,
      owner,
      name,
      htmlUrl: `https://github.com/${fullName}`,
      description: descEl?.innerText?.trim() || null,
      primaryLanguage: langEl?.innerText?.trim() || null,
      starCount: starCountEl?.innerText?.trim() || null,
      forkCount: forkCountEl?.innerText?.trim() || null,
      topics,
      updatedAt: timeEl?.getAttribute('datetime') || null
    })
  }

  // 翻页链接解析
  const nextBtn = doc.querySelector('.paginate-container a.next_page')
    || doc.querySelector('.paginate-container a[rel="next"]')
    || Array.from(doc.querySelectorAll('.paginate-container a')).find(a => a.innerText.includes('Next'))

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

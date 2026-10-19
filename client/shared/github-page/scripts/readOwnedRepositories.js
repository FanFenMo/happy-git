/**
 * readOwnedRepositories.js
 * 从用户的仓库列表页面提取公开仓库条目及翻页信息 (依据 project.md 第六节)
 */

export function run(doc, args = {}) {
  const expectedLogin = args.expectedLogin || ''
  const pageSeq = args.pageSeq || 1

  const listItems = Array.from(doc.querySelectorAll('#user-repositories-list li, [data-filterable-for="your-repos-filter"] li'))
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

  for (const li of listItems) {
    const titleLink = li.querySelector('a[itemprop="name codeRepository"]') || li.querySelector('h3 a')
    if (!titleLink) continue

    const name = titleLink.innerText.trim()
    const href = titleLink.getAttribute('href') || ''
    const fullName = href.replace(/^\//, '').split('?')[0] || `${expectedLogin}/${name}`

    // 检查可见性 (Public / Private)
    const label = li.querySelector('.Label--secondary')?.innerText?.toLowerCase() || ''
    let isPrivate = label.includes('private')
    let visibility = isPrivate ? 'private' : 'public'

    // 过滤私有仓库
    if (isPrivate) continue

    const descEl = li.querySelector('p[itemprop="description"]') || li.querySelector('.description')
    const langEl = li.querySelector('span[itemprop="programmingLanguage"]')
    const isFork = Boolean(li.querySelector('.fork-flag') || li.innerText.includes('Forked from'))
    const timeEl = li.querySelector('relative-time') || li.querySelector('time-ago') || li.querySelector('time')

    // 许可证提取
    let licenseSpdx = null
    const textContent = li.innerText
    if (textContent.includes('MIT License') || textContent.includes('MIT')) licenseSpdx = 'MIT'
    else if (textContent.includes('Apache-2.0') || textContent.includes('Apache 2.0')) licenseSpdx = 'Apache-2.0'
    else if (textContent.includes('GPL-3.0') || textContent.includes('GPLv3')) licenseSpdx = 'GPL-3.0'

    // Topics 标签提取
    const topicEls = Array.from(li.querySelectorAll('a.topic-tag, [data-ga-click*="topic"]'))
    const topics = topicEls.map(el => el.innerText.trim().replace(/^#/, '')).filter(Boolean)

    items.push({
      fullName,
      name,
      owner: fullName.split('/')[0] || expectedLogin,
      htmlUrl: `https://github.com/${fullName}`,
      description: descEl?.innerText?.trim() || null,
      primaryLanguage: langEl?.innerText?.trim() || null,
      topics,
      isFork,
      visibility,
      licenseSpdx,
      updatedAt: timeEl?.getAttribute('datetime') || null
    })
  }

  // 翻页与结束证据提取
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

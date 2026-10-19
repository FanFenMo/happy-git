/**
 * readTrendingResults.js
 * 从 GitHub Trending 页面提取热门趋势开源项目条目 (依据 project.md 第六节)
 */

export function run(doc, args = {}) {
  const rows = Array.from(doc.querySelectorAll('article.Box-row, .Box .Box-row'))
  const items = []

  for (const row of rows) {
    const titleLink = row.querySelector('h2 a') || row.querySelector('h1 a') || row.querySelector('h3 a')
    if (!titleLink) continue

    const href = titleLink.getAttribute('href') || ''
    const clean = href.replace(/^\//, '').split('?')[0]
    if (!clean || !clean.includes('/')) continue

    const parts = clean.split('/')
    const fullName = `${parts[0]}/${parts[1]}`

    const descEl = row.querySelector('p')
    const langEl = row.querySelector('[itemprop="programmingLanguage"]')
    const starEl = row.querySelector('a[href*="/stargazers"]')
    const forkEl = row.querySelector('a[href*="/forks"]')

    items.push({
      fullName,
      owner: parts[0],
      name: parts[1],
      htmlUrl: `https://github.com/${fullName}`,
      description: descEl?.innerText?.trim() || null,
      primaryLanguage: langEl?.innerText?.trim() || null,
      starCount: starEl?.innerText?.trim() || null,
      forkCount: forkEl?.innerText?.trim() || null
    })
  }

  return {
    items,
    nextUrl: null,
    completion: 'end'
  }
}

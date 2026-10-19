/**
 * readRepositoryDetail.js
 * 从仓库主页提取稳定数字 repoId、元数据及 README 文本内容 (依据 project.md 第六节)
 */

export function run(doc, args = {}) {
  const expectedFullName = args.expectedFullName || ''

  // 1. 提取稳定数字 repoId
  let repoId = doc.querySelector('meta[name="octolytics-dimension-repository_id"]')?.getAttribute('content')
    || doc.querySelector('[data-view-component="true"] form[action*="/star"] input[name="repository_id"]')?.value
    || null

  // 2. 规范化仓库名称与所有者
  let fullName = expectedFullName
  const repoHeader = doc.querySelector('#repository-container-header')
  if (repoHeader) {
    const ownerEl = repoHeader.querySelector('span.author a')
    const nameEl = repoHeader.querySelector('strong[itemprop="name"] a')
    if (ownerEl && nameEl) {
      fullName = `${ownerEl.innerText.trim()}/${nameEl.innerText.trim()}`
    }
  }

  const parts = fullName.split('/')
  const owner = parts[0] || ''
  const name = parts[1] || ''

  // 3. 简介与元数据
  const descEl = doc.querySelector('p[itemprop="description"]') || doc.querySelector('.f4.my-3')
  const langEl = doc.querySelector('[itemprop="programmingLanguage"]') || doc.querySelector('li.d-inline span.color-fg-default')

  // Topics
  const topicEls = Array.from(doc.querySelectorAll('a.topic-tag, [data-ga-click*="Topic"]'))
  const topics = topicEls.map(el => el.innerText.trim().replace(/^#/, '')).filter(Boolean)

  // Star & Fork 数
  const starCountEl = doc.querySelector('#repo-stars-counter-star')
    || doc.querySelector('#repo-stars-counter-unstar')
    || doc.querySelector('a[href*="/stargazers"] span.Counter')
  const forkCountEl = doc.querySelector('#repo-network-counter')
    || doc.querySelector('a[href*="/forks"] span.Counter')

  // 许可证 License
  let licenseSpdx = null
  const licenseEl = doc.querySelector('a[href*="/LICENSE"] h3')
    || doc.querySelector('svg.octicon-law + span')
    || Array.from(doc.querySelectorAll('a[href*="/LICENSE"]')).find(a => a.innerText.includes('License'))
  if (licenseEl) {
    licenseSpdx = licenseEl.innerText.trim().replace(/License$/i, '').trim()
  }

  // 4. README 文本内容 (提取纯文本，去除脚本与多余格式，上限 8000 字符)
  let readmeText = null
  const readmeArticle = doc.querySelector('#readme article') || doc.querySelector('.markdown-body')
  if (readmeArticle) {
    // 简单获取文本并去除连续空白
    const text = (readmeArticle.innerText || '').replace(/\s+/g, ' ').trim()
    readmeText = text.slice(0, 8000)
  }

  return {
    repoId: repoId ? String(repoId) : null,
    owner,
    name,
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    description: descEl?.innerText?.trim() || null,
    primaryLanguage: langEl?.innerText?.trim() || null,
    topics,
    starCount: starCountEl?.innerText?.trim() || null,
    forkCount: forkCountEl?.innerText?.trim() || null,
    licenseSpdx,
    readmeText
  }
}

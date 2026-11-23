/**
 * readRepositoryDetail.js
 * 从仓库主页提取稳定数字 repoId、元数据及 README 文本内容 (兼容新版 React 侧栏与传统结构)
 */

export function run(doc, args = {}) {
  const expectedFullName = args.expectedFullName || ''

  function extractText(el) {
    if (!el) return ''
    return String(el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
  }

  function extractSidebarAbout() {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null
    const scripts = Array.from(doc.querySelectorAll('script[type="application/json"]'))
    for (const s of scripts) {
      const raw = s.textContent || ''
      if (!raw || (!raw.includes('sidebarAboutData') && !raw.includes('sidebarAbout'))) continue
      try {
        const parsed = JSON.parse(raw)
        const candidates = [
          parsed?.payload?.codeViewOverviewRoute?.sidebarAboutData,
          parsed?.payload?.codeViewOverviewRoute?.sidebarAbout,
          parsed?.payload?.sidebarAboutData,
          parsed?.payload?.sidebarAbout,
          parsed?.props?.initialPayload?.overview?.sidebarAboutData
        ]
        for (const c of candidates) {
          if (c && typeof c === 'object') return c
        }
        // 递归浅查 4 层定位 sidebarAboutData / sidebarAbout
        const queue = [{ node: parsed, depth: 0 }]
        while (queue.length > 0) {
          const { node, depth } = queue.shift()
          if (!node || typeof node !== 'object' || depth > 4) continue
          if (node.sidebarAboutData && typeof node.sidebarAboutData === 'object') return node.sidebarAboutData
          if (node.sidebarAbout && typeof node.sidebarAbout === 'object') return node.sidebarAbout
          for (const val of Object.values(node)) {
            if (val && typeof val === 'object' && !Array.isArray(val)) {
              queue.push({ node: val, depth: depth + 1 })
            }
          }
        }
      } catch (_) {}
    }
    return null
  }

  const about = extractSidebarAbout()

  // 1. 提取稳定数字 repoId
  let repoId = doc.querySelector('meta[name="octolytics-dimension-repository_id"]')?.getAttribute('content')
    || doc.querySelector('[data-view-component="true"] form[action*="/star"] input[name="repository_id"]')?.value
    || (about?.repo?.id != null ? String(about.repo.id) : null)
    || null

  // 2. 规范化仓库名称与所有者
  let fullName = expectedFullName
  const repoHeader = doc.querySelector('#repository-container-header')
  if (repoHeader) {
    const ownerEl = repoHeader.querySelector('span.author a')
    const nameEl = repoHeader.querySelector('strong[itemprop="name"] a')
    if (ownerEl && nameEl) {
      fullName = `${extractText(ownerEl)}/${extractText(nameEl)}`
    }
  }
  if ((!fullName || !fullName.includes('/')) && about?.ownerLogin && about?.repoName) {
    fullName = `${about.ownerLogin}/${about.repoName}`
  }

  const parts = fullName.split('/')
  const owner = parts[0] || ''
  const name = parts[1] || ''

  // 3. 简介与元数据
  const descEl = doc.querySelector('p[itemprop="description"]')
    || doc.querySelector('.f4.my-3')
    || doc.querySelector('p[class*="description__"]')
  let description = extractText(descEl) || (typeof about?.description === 'string' ? about.description.trim() : '')
  if (!description) {
    const metaDesc = doc.querySelector('meta[property="og:description"]')?.getAttribute('content')
      || doc.querySelector('meta[name="description"]')?.getAttribute('content')
      || ''
    if (metaDesc) {
      // GitHub meta description 末尾常附带 " - owner/repo" 或 "Contribute to owner/repo..."
      const trimmed = metaDesc.replace(new RegExp(`\\s*-\\s*${fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '').trim()
      if (trimmed && !/^Contribute to\s+/i.test(trimmed)) {
        description = trimmed
      }
    }
  }

  const langEl = doc.querySelector('[itemprop="programmingLanguage"]')
    || doc.querySelector('li.d-inline span.color-fg-default')

  // Topics
  const topicEls = Array.from(doc.querySelectorAll('a.topic-tag, a[href^="/topics/"], [data-ga-click*="Topic"]'))
  const topicSet = new Set()
  for (const el of topicEls) {
    const t = extractText(el).replace(/^#/, '')
    if (t) topicSet.add(t)
  }
  if (Array.isArray(about?.topics)) {
    for (const item of about.topics) {
      const t = String(typeof item === 'string' ? item : (item?.name || '')).trim().replace(/^#/, '')
      if (t) topicSet.add(t)
    }
  }
  const topics = Array.from(topicSet)

  // Star & Fork 数
  const starCountEl = doc.querySelector('#repo-stars-counter-star')
    || doc.querySelector('#repo-stars-counter-unstar')
    || doc.querySelector('a[href*="/stargazers"] span.Counter')
  const forkCountEl = doc.querySelector('#repo-network-counter')
    || doc.querySelector('a[href*="/forks"] span.Counter')

  // 许可证 License
  let licenseSpdx = about?.repo?.license?.spdxId || null
  if (!licenseSpdx) {
    const licenseEl = doc.querySelector('a[href*="/LICENSE"] h3')
      || doc.querySelector('svg.octicon-law + span')
      || Array.from(doc.querySelectorAll('a[href*="/LICENSE"]')).find(a => extractText(a).includes('License'))
    if (licenseEl) {
      licenseSpdx = extractText(licenseEl).replace(/License$/i, '').trim()
    }
  }

  // 4. README 文本内容 (提取纯文本，去除脚本与多余格式，上限 8000 字符)
  let readmeText = null
  const readmeArticle = doc.querySelector('#readme article') || doc.querySelector('.markdown-body')
  if (readmeArticle) {
    const text = extractText(readmeArticle)
    readmeText = text.slice(0, 8000)
  }

  return {
    repoId: repoId ? String(repoId) : null,
    owner,
    name,
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    description: description || null,
    primaryLanguage: extractText(langEl) || null,
    topics,
    starCount: extractText(starCountEl) || (about?.stargazerCount != null ? String(about.stargazerCount) : null),
    forkCount: extractText(forkCountEl) || (about?.forksCount != null ? String(about.forksCount) : null),
    licenseSpdx,
    readmeText
  }
}

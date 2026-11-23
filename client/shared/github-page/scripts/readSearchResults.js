/**
 * readSearchResults.js
 * 从 GitHub 搜索页面提取仓库搜索候选条目及翻页信息 (兼容新版 React 搜索卡片、内嵌 JSON 与旧版列表结构)
 */

export function run(doc, args = {}) {
  const pageSeq = args.pageSeq || 1

  function cleanHtmlText(raw) {
    if (!raw || typeof raw !== 'string') return ''
    let text = raw
    if (typeof doc?.createElement === 'function') {
      try {
        const el = doc.createElement('div')
        el.innerHTML = raw
        text = el.textContent || el.innerText || ''
      } catch (_) {
        text = raw.replace(/<[^>]+>/g, '')
      }
    } else {
      text = raw.replace(/<[^>]+>/g, '')
    }
    return text.replace(/\s+/g, ' ').trim()
  }

  function extractEmbeddedResults() {
    const map = new Map()
    const ordered = []
    if (!doc || typeof doc.querySelectorAll !== 'function') return { map, ordered }
    const scripts = Array.from(doc.querySelectorAll('script[type="application/json"]'))
    for (const s of scripts) {
      const target = s.getAttribute?.('data-target') || ''
      if (target && target !== 'react-app.embeddedData' && target !== 'react-partial.embeddedData') continue
      const raw = s.textContent || ''
      if (!raw || (!raw.includes('blackbirdSearchRoute') && !raw.includes('"hl_name"'))) continue
      try {
        const parsed = JSON.parse(raw)
        const results = parsed?.payload?.blackbirdSearchRoute?.results
          || parsed?.payload?.results
          || parsed?.props?.initialPayload?.results
          || null
        if (!Array.isArray(results) || results.length === 0) continue
        for (const r of results) {
          const repoObj = r?.repo?.repository || null
          let fullName = ''
          if (repoObj?.owner_login && repoObj?.name) {
            fullName = `${repoObj.owner_login}/${repoObj.name}`
          } else if (r?.hl_name) {
            fullName = cleanHtmlText(r.hl_name)
          }
          if (!fullName || !fullName.includes('/')) continue
          const parts = fullName.split('/')
          if (parts.length < 2) continue
          const key = `${parts[0]}/${parts[1]}`.toLowerCase()
          const desc = cleanHtmlText(r.hl_trunc_description || r.description || '') || null
          const topics = Array.isArray(r.topics)
            ? r.topics.map(t => String(typeof t === 'string' ? t : (t?.name || '')).trim().replace(/^#/, '')).filter(Boolean)
            : []
          const entry = {
            repoId: r.id != null ? String(r.id) : (repoObj?.id != null ? String(repoObj.id) : null),
            fullName: `${parts[0]}/${parts[1]}`,
            owner: parts[0],
            name: parts[1],
            htmlUrl: `https://github.com/${parts[0]}/${parts[1]}`,
            description: desc,
            primaryLanguage: r.language ? String(r.language).trim() : null,
            starCount: r.followers != null ? String(r.followers) : null,
            topics,
            updatedAt: repoObj?.updated_at || r.updated_at || null
          }
          if (!map.has(key)) {
            map.set(key, entry)
            ordered.push(entry)
          }
        }
      } catch (_) {}
    }
    return { map, ordered }
  }

  function extractText(el) {
    if (!el) return ''
    return String(el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
  }

  function parseUpdatedTitle(card) {
    const timeEl = card.querySelector('relative-time') || card.querySelector('time')
    const dt = timeEl?.getAttribute?.('datetime')
    if (dt) return dt
    const lis = Array.from(card.querySelectorAll('li'))
    for (const li of lis) {
      const txt = extractText(li)
      if (!/updated/i.test(txt)) continue
      const titled = li.querySelector('[title]')
      const titleVal = titled?.getAttribute?.('title')
      if (titleVal) {
        const ms = Date.parse(titleVal)
        if (!Number.isNaN(ms)) return new Date(ms).toISOString()
      }
    }
    return null
  }

  const { map: embeddedMap, ordered: embeddedOrdered } = extractEmbeddedResults()

  const rows = Array.from(doc.querySelectorAll('.repo-list-item, [data-testid="results-list"] > div, .search-title a'))
  const blankslate = doc.querySelector('.blankslate') || (doc.body?.innerText || '').includes('We couldn’t find any repositories')

  if (rows.length === 0 && embeddedOrdered.length === 0 && blankslate) {
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
    const titleLink = card.querySelector('.search-title a')
      || card.querySelector('a.v-align-middle')
      || card.querySelector('h3 a')
      || card.querySelector('a[href*="/"]')
    if (!titleLink) continue

    const href = titleLink.getAttribute('href') || ''
    const cleanHref = href.replace(/^\//, '').split('?')[0]
    if (!cleanHref || !cleanHref.includes('/') || cleanHref.startsWith('search')) continue

    const parts = cleanHref.split('/')
    if (parts.length < 2) continue

    const fullName = `${parts[0]}/${parts[1]}`
    const key = fullName.toLowerCase()
    if (seenKeys.has(key)) continue
    seenKeys.add(key)

    const embedded = embeddedMap.get(key) || null
    const isLegacyCard = Boolean(card.classList?.contains?.('repo-list-item'))

    // 1. 提取简介：优先新版 React 卡片中的描述节点，避免误取 Sponsor 弹窗或用户浮层的 <p>
    let domDesc = ''
    const matchSpans = Array.from(card.querySelectorAll('.search-match'))
    const descMatch = matchSpans.find(el => !(typeof el.closest === 'function' && el.closest('h3, .search-title')))
    if (descMatch) {
      domDesc = extractText(descMatch)
    }
    if (!domDesc) {
      const contentBox = card.querySelector('div[class*="Content__"]')
      if (contentBox) domDesc = extractText(contentBox)
    }
    if (!domDesc && isLegacyCard) {
      const legacyDesc = card.querySelector('p') || card.querySelector('.mb-1')
      domDesc = extractText(legacyDesc)
    }
    const description = domDesc || embedded?.description || null

    // 2. 提取主语言
    const langEl = card.querySelector('span[aria-label$=" language"]')
      || card.querySelector('[itemprop="programmingLanguage"]')
      || (isLegacyCard ? card.querySelector('span.color-fg-muted') : null)
    let primaryLanguage = extractText(langEl) || embedded?.primaryLanguage || null
    if (!primaryLanguage && langEl?.getAttribute?.('aria-label')) {
      primaryLanguage = langEl.getAttribute('aria-label').replace(/\s+language$/i, '').trim() || null
    }

    // 3. 提取星标数（优先精确数值）
    const starEl = card.querySelector('a[href*="/stargazers"]')
    const starAria = starEl?.getAttribute?.('aria-label') || ''
    const starAriaMatch = starAria.match(/([\d,]+)\s*star/i)
    const starCount = embedded?.starCount || (starAriaMatch ? starAriaMatch[1] : null) || extractText(starEl) || null

    // 4. 提取 Topics（合并 DOM 与内嵌全量列表）
    const topicEls = Array.from(card.querySelectorAll('a[href^="/topics/"], a.topic-tag, [data-ga-click*="topic"]'))
    const topicSet = new Set()
    for (const el of topicEls) {
      const t = extractText(el).replace(/^#/, '')
      if (t) topicSet.add(t)
    }
    if (Array.isArray(embedded?.topics)) {
      for (const t of embedded.topics) {
        if (t) topicSet.add(t)
      }
    }
    const topics = Array.from(topicSet)

    // 5. 提取更新时间
    const updatedAt = embedded?.updatedAt || parseUpdatedTitle(card) || null

    items.push({
      repoId: embedded?.repoId || null,
      fullName,
      owner: parts[0],
      name: parts[1],
      htmlUrl: `https://github.com/${fullName}`,
      description,
      primaryLanguage,
      starCount,
      topics,
      updatedAt
    })
  }

  // 若 DOM 尚未挂载出卡片但内嵌 JSON 已包含结果，兜底返回结构化结果
  if (items.length === 0 && embeddedOrdered.length > 0) {
    for (const entry of embeddedOrdered) {
      items.push(entry)
    }
  }

  // 翻页链接
  const nextBtn = doc.querySelector('a.next_page')
    || doc.querySelector('a[rel="next"]')
    || Array.from(doc.querySelectorAll('.paginate-container a, nav[aria-label="Pagination"] a')).find(a => extractText(a).includes('Next'))

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

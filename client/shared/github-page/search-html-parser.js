/**
 * shared/github-page/search-html-parser.js
 * 直接从 GitHub 搜索页原始 HTML 中的 react-app.embeddedData 提取结构化仓库列表，
 * 避免后台隐藏浏览器串行渲染整页 JS/CSS/图片导致的数十秒等待。
 */

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return ''
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function cleanSnippet(raw) {
  if (!raw || typeof raw !== 'string') return ''
  return decodeHtmlEntities(raw.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function extractEmbeddedDataScripts(html) {
  const bodies = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let match
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1] || ''
    if (!/type=["']application\/json["']/i.test(attrs)) continue
    if (!/data-target=["']react-(?:app|partial)\.embeddedData["']/i.test(attrs)) continue
    if (match[2]) bodies.push(match[2])
  }
  return bodies
}

/**
 * 解析 GitHub 搜索页 HTML。
 * - 若命中速率限制返回 { rateLimited: true }
 * - 若成功从 embeddedData 解析出结果（或确认空结果页）返回 { items, nextUrl, completion, pageSeq, pageCount }
 * - 若页面结构不可识别（例如需要登录跳转或改版），返回 null 由调用方自动回退到隐藏浏览器执行
 */
export function parseGitHubSearchHtml(html, { pageSeq = 1, requestUrl = '' } = {}) {
  if (!html || typeof html !== 'string') return null

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? titleMatch[1] : ''
  if (/Rate limit|Whoa there!/i.test(title)) {
    return { rateLimited: true, items: [], nextUrl: null, completion: 'end', pageSeq }
  }

  const scriptBodies = extractEmbeddedDataScripts(html)
  for (const raw of scriptBodies) {
    if (!raw.includes('blackbirdSearchRoute') && !raw.includes('"hl_name"')) continue
    try {
      const parsed = JSON.parse(raw)
      const route = parsed?.payload?.blackbirdSearchRoute || parsed?.payload || null
      const results = route?.results
      if (!Array.isArray(results)) continue

      const items = []
      const seen = new Set()
      for (const r of results) {
        const repoObj = r?.repo?.repository || null
        let fullName = ''
        if (repoObj?.owner_login && repoObj?.name) {
          fullName = `${repoObj.owner_login}/${repoObj.name}`
        } else if (r?.hl_name) {
          fullName = cleanSnippet(r.hl_name)
        }
        if (!fullName || !fullName.includes('/')) continue
        const parts = fullName.split('/')
        if (parts.length < 2) continue
        const normalizedFullName = `${parts[0]}/${parts[1]}`
        const key = normalizedFullName.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)

        const description = cleanSnippet(r.hl_trunc_description || r.description || '') || null
        const topics = Array.isArray(r.topics)
          ? r.topics
            .map(t => String(typeof t === 'string' ? t : (t?.name || '')).trim().replace(/^#/, ''))
            .filter(Boolean)
          : []

        items.push({
          repoId: r.id != null ? String(r.id) : (repoObj?.id != null ? String(repoObj.id) : null),
          fullName: normalizedFullName,
          owner: parts[0],
          name: parts[1],
          htmlUrl: `https://github.com/${normalizedFullName}`,
          description,
          primaryLanguage: r.language ? String(r.language).trim() : null,
          starCount: r.followers != null ? String(r.followers) : null,
          topics,
          updatedAt: repoObj?.updated_at || r.updated_at || null
        })
      }

      const pageCount = Number(route?.page_count || 0)
      const rawResultCount = route?.result_count ?? route?.results_count
      const resultCount = rawResultCount != null && Number.isFinite(Number(rawResultCount))
        ? Number(rawResultCount)
        : null
      let nextUrl = null
      let completion = 'end'
      if (items.length > 0 && pageCount > pageSeq) {
        completion = 'more'
        if (requestUrl) {
          try {
            const u = new URL(requestUrl)
            u.searchParams.set('p', String(pageSeq + 1))
            nextUrl = u.toString()
          } catch (_) {
            nextUrl = `https://github.com/search?p=${pageSeq + 1}`
          }
        } else {
          nextUrl = `https://github.com/search?p=${pageSeq + 1}`
        }
      }

      return {
        rateLimited: false,
        items,
        nextUrl,
        completion,
        pageSeq,
        pageCount,
        resultCount
      }
    } catch (_) {}
  }

  return null
}

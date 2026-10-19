/**
 * detectPage.js
 * 识别当前 GitHub 页面的结构与类型
 */

export function run(doc) {
  const loc = doc.location || window.location || {}
  const pathname = loc.pathname || ''
  const search = loc.search || ''

  // 1. 登录与认证页面
  if (pathname === '/login' || pathname.startsWith('/login/') || doc.querySelector('#login_field') || doc.querySelector('.session-authentication')) {
    return {
      origin: loc.origin || 'https://github.com',
      pathname,
      pageKind: 'login',
      hasStructure: Boolean(doc.querySelector('#login_field') || doc.querySelector('form[action*="/session"]'))
    }
  }

  // 2. 二次验证与设备核验
  if (pathname.includes('/sessions/two-factor') || doc.querySelector('input[name="otp"]') || doc.querySelector('.two-factor-help')) {
    return {
      origin: loc.origin || 'https://github.com',
      pathname,
      pageKind: 'verify',
      hasStructure: true
    }
  }

  // 3. 错误与频次受限
  if (doc.title && (doc.title.includes('Rate limit') || doc.title.includes('Whoa there!'))) {
    return {
      origin: loc.origin || 'https://github.com',
      pathname,
      pageKind: 'rate_limit',
      hasStructure: true
    }
  }
  if (doc.title && doc.title.includes('Page not found')) {
    return {
      origin: loc.origin || 'https://github.com',
      pathname,
      pageKind: 'not_found',
      hasStructure: true
    }
  }

  // 4. 搜索结果页
  if (pathname === '/search' || pathname.startsWith('/search/')) {
    const list = doc.querySelector('.repo-list') || doc.querySelector('[data-testid="results-list"]') || doc.querySelector('[data-testid="search-sub-header"]')
    const blank = doc.querySelector('.blankslate') || doc.body?.innerText?.includes('We couldn’t find any repositories')
    return {
      origin: loc.origin || 'https://github.com',
      pathname,
      pageKind: 'search',
      hasStructure: Boolean(list || blank)
    }
  }

  // 5. 趋势页
  if (pathname === '/trending' || pathname.startsWith('/trending/')) {
    const box = doc.querySelector('.Box .Box-row') || doc.querySelector('article.Box-row')
    return {
      origin: loc.origin || 'https://github.com',
      pathname,
      pageKind: 'trending',
      hasStructure: Boolean(box)
    }
  }

  // 6. 个人主页与 Tab (repositories, stars)
  if (doc.querySelector('.vcard-names') || doc.querySelector('.user-profile-bio') || doc.querySelector('nav[aria-label="User profile"]')) {
    if (search.includes('tab=repositories')) {
      return { origin: loc.origin, pathname, pageKind: 'repositories', hasStructure: true }
    }
    if (search.includes('tab=stars')) {
      return { origin: loc.origin, pathname, pageKind: 'stars', hasStructure: true }
    }
    return { origin: loc.origin, pathname, pageKind: 'profile', hasStructure: true }
  }

  // 7. 仓库详情页
  if (doc.querySelector('#repository-container-header') || doc.querySelector('strong[itemprop="name"] a') || doc.querySelector('meta[name="octolytics-dimension-repository_id"]')) {
    return { origin: loc.origin, pathname, pageKind: 'repository', hasStructure: true }
  }

  return {
    origin: loc.origin || 'https://github.com',
    pathname,
    pageKind: 'unknown',
    hasStructure: false
  }
}

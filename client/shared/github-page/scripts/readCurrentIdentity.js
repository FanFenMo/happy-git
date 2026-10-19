/**
 * readCurrentIdentity.js
 * 提取当前 GitHub 页面中代表“已登录用户”的身份依据 (依据 project.md 第五节)
 */

export function run(doc) {
  // 1. 检查是否在明确的登录或未登录页面
  if (doc.querySelector('#login_field') || (doc.location?.pathname === '/login')) {
    return { kind: 'anonymous', accountId: null, login: null, evidence: 'login_page' }
  }

  // 2. 检查是否在二次验证或设备确认页面
  if (doc.location?.pathname?.includes('/sessions/two-factor') || doc.querySelector('input[name="otp"]')) {
    return { kind: 'verification', accountId: null, login: null, evidence: 'two_factor_prompt' }
  }

  // 3. 检查 GitHub 官方 meta 标签
  const metaActorId = doc.querySelector('meta[name="octolytics-actor-id"]')?.getAttribute('content')
  const metaActorLogin = doc.querySelector('meta[name="octolytics-actor-login"]')?.getAttribute('content')
  const metaUserLogin = doc.querySelector('meta[name="user-login"]')?.getAttribute('content')

  const login = (metaActorLogin || metaUserLogin || '').trim()
  const accountId = (metaActorId && metaActorId !== '0') ? metaActorId.trim() : null

  if (login && login !== 'undefined' && login !== 'null') {
    return {
      kind: 'authenticated',
      accountId: accountId || null,
      login,
      evidence: metaActorId ? 'octolytics_actor' : 'user_login_meta'
    }
  }

  // 4. 检查用户菜单/头像上的登录用户名
  const headerUser = doc.querySelector('[data-login]')?.getAttribute('data-login')
    || doc.querySelector('img.avatar-user')?.getAttribute('alt')?.replace(/^@/, '')
    || doc.querySelector('summary[aria-label*="View profile and more"] img')?.getAttribute('alt')?.replace(/^@/, '')

  if (headerUser && headerUser !== 'undefined' && headerUser !== 'null') {
    return {
      kind: 'authenticated',
      accountId: accountId || null,
      login: headerUser.trim(),
      evidence: 'header_avatar_user'
    }
  }

  // 5. 检查是否可见 Sign in 按钮（确定为未登录）
  const signInLink = doc.querySelector('a[href*="/login"]') || doc.querySelector('a[data-ga-click*="Sign in"]')
  if (signInLink) {
    return { kind: 'anonymous', accountId: null, login: null, evidence: 'sign_in_link_visible' }
  }

  return { kind: 'unknown', accountId: null, login: null, evidence: 'no_identity_markers' }
}

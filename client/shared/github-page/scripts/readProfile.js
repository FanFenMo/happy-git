/**
 * readProfile.js
 * 从 GitHub 个人页面提取公开资料与数量
 */

export function run(doc, args = {}) {
  const expectedLogin = args.expectedLogin || ''

  const nicknameEl = doc.querySelector('.p-nickname') || doc.querySelector('.vcard-username')
  const fullnameEl = doc.querySelector('.p-name') || doc.querySelector('.vcard-fullname')
  const avatarEl = doc.querySelector('img.avatar-user') || doc.querySelector('.avatar-user')
  const bioEl = doc.querySelector('.user-profile-bio') || doc.querySelector('[data-bio-text]')

  const locationEl = doc.querySelector('li[itemprop="homeLocation"]') || doc.querySelector('[itemprop="homeLocation"]')
  const companyEl = doc.querySelector('li[itemprop="worksFor"]') || doc.querySelector('[itemprop="worksFor"]')

  const repoCounter = doc.querySelector('a[href*="tab=repositories"] span.Counter') || doc.querySelector('[data-tab-item="repositories"] span.Counter')
  const followerCounter = doc.querySelector('a[href*="tab=followers"] span.Counter')
  const followingCounter = doc.querySelector('a[href*="tab=following"] span.Counter')

  const login = (nicknameEl?.innerText || '').trim() || expectedLogin
  const displayName = (fullnameEl?.innerText || '').trim() || null
  const avatarUrl = avatarEl?.getAttribute('src') || null
  const bio = (bioEl?.innerText || '').trim() || null
  const location = (locationEl?.innerText || '').trim() || null
  const company = (companyEl?.innerText || '').trim() || null

  // 尝试从页面或头像提取稳定数字 accountId
  let accountId = doc.querySelector('meta[name="octolytics-dimension-user_id"]')?.getAttribute('content')
    || doc.querySelector('[data-scope-id]')?.getAttribute('data-scope-id')
    || null

  if (!accountId && avatarUrl) {
    const m = avatarUrl.match(/\/u\/(\d+)/)
    if (m && m[1]) accountId = m[1]
  }

  return {
    accountId: accountId || null,
    login,
    displayName,
    avatarUrl,
    profileUrl: `https://github.com/${login}`,
    bio,
    location,
    company,
    publicRepoCount: repoCounter?.innerText?.trim() || null,
    followerCount: followerCounter?.innerText?.trim() || null,
    followingCount: followingCounter?.innerText?.trim() || null
  }
}

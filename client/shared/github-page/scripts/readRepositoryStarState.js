/**
 * readRepositoryStarState.js
 * 读取目标仓库主操作区的当前 Star 状态 (starred / unstarred / unknown)
 */

export function run(doc, args = {}) {
  // 只定位目标仓库主操作区中的 Star 控件（排除 README 内按钮或其它无关按钮）
  const container = doc.querySelector('#repository-container-header') || doc.querySelector('.pagehead-actions') || doc

  const unstarBtn = container.querySelector('form[action*="/unstar"] button')
    || container.querySelector('button[aria-label*="Unstar this repository"]')
    || container.querySelector('[data-ga-click*="Unstar"]')

  const starBtn = container.querySelector('form[action*="/star"]:not([action*="/unstar"]) button')
    || container.querySelector('button[aria-label*="Star this repository"]')
    || container.querySelector('[data-ga-click*="Star"]:not([data-ga-click*="Unstar"])')

  const now = Date.now()

  if (unstarBtn && (!starBtn || unstarBtn.offsetParent !== null)) {
    return { state: 'starred', starred: true, observedAt: now }
  }

  if (starBtn && (!unstarBtn || starBtn.offsetParent !== null)) {
    return { state: 'unstarred', starred: false, observedAt: now }
  }

  // 检查按钮文本与 svg 图标
  const allBtns = Array.from(container.querySelectorAll('button'))
  for (const b of allBtns) {
    const text = b.innerText.trim().toLowerCase()
    if (text === 'starred' || text.startsWith('unstar')) {
      return { state: 'starred', starred: true, observedAt: now }
    }
    if (text === 'star') {
      return { state: 'unstarred', starred: false, observedAt: now }
    }
  }

  return { state: 'unknown', starred: null, observedAt: now }
}

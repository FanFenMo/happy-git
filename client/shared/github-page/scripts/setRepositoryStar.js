/**
 * setRepositoryStar.js
 * 定位目标仓库主操作区按钮，执行单次原生网页点击或表单提交操作 (依据 project.md 第六节)
 */

export function run(doc, args = {}) {
  const desiredStarred = Boolean(args.desiredStarred)
  const container = doc.querySelector('#repository-container-header') || doc.querySelector('.pagehead-actions') || doc

  if (desiredStarred) {
    // 目标为 Star，寻找 Star 按钮并点击
    const starBtn = container.querySelector('form[action*="/star"]:not([action*="/unstar"]) button')
      || container.querySelector('button[aria-label*="Star this repository"]')
      || Array.from(container.querySelectorAll('button')).find(b => b.innerText.trim().toLowerCase() === 'star')

    if (starBtn && typeof starBtn.click === 'function') {
      starBtn.click()
      return { clicked: true, desiredStarred: true, action: 'clicked_star' }
    }

    const starForm = container.querySelector('form[action*="/star"]:not([action*="/unstar"])')
    if (starForm && typeof starForm.submit === 'function') {
      starForm.submit()
      return { clicked: true, desiredStarred: true, action: 'submitted_star_form' }
    }
  } else {
    // 目标为 Unstar，寻找 Unstar 按钮并点击
    const unstarBtn = container.querySelector('form[action*="/unstar"] button')
      || container.querySelector('button[aria-label*="Unstar this repository"]')
      || Array.from(container.querySelectorAll('button')).find(b => {
        const t = b.innerText.trim().toLowerCase()
        return t === 'starred' || t.startsWith('unstar')
      })

    if (unstarBtn && typeof unstarBtn.click === 'function') {
      unstarBtn.click()
      return { clicked: true, desiredStarred: false, action: 'clicked_unstar' }
    }

    const unstarForm = container.querySelector('form[action*="/unstar"]')
    if (unstarForm && typeof unstarForm.submit === 'function') {
      unstarForm.submit()
      return { clicked: true, desiredStarred: false, action: 'submitted_unstar_form' }
    }
  }

  return {
    clicked: false,
    desiredStarred,
    reason: 'target_button_not_found'
  }
}

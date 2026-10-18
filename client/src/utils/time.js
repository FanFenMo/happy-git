/**
 * 时间展示工具
 */

export function formatHistoryTime(timestamp, now = Date.now()) {
  if (!timestamp) return ''
  const target = new Date(timestamp)
  const current = new Date(now)

  const pad = (n) => String(n).padStart(2, '0')

  const targetYear = target.getFullYear()
  const targetMonth = target.getMonth()
  const targetDate = target.getDate()

  const currentYear = current.getFullYear()
  const currentMonth = current.getMonth()
  const currentDate = current.getDate()

  const hours = pad(target.getHours())
  const minutes = pad(target.getMinutes())

  // 判断是否为同一自然日 (今天)
  if (targetYear === currentYear && targetMonth === currentMonth && targetDate === currentDate) {
    return `${hours}:${minutes}`
  }

  // 判断是否为自然日 (昨天)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (
    targetYear === yesterday.getFullYear() &&
    targetMonth === yesterday.getMonth() &&
    targetDate === yesterday.getDate()
  ) {
    return `昨天 ${hours}:${minutes}`
  }

  // 更早自然日
  const monthStr = pad(targetMonth + 1)
  const dateStr = pad(targetDate)
  return `${targetYear}-${monthStr}-${dateStr} ${hours}:${minutes}`
}

export function getCutoffDate(monthsAgo = 3) {
  const d = new Date()
  const currentDay = d.getDate()
  d.setMonth(d.getMonth() - monthsAgo)

  // 处理月份天数溢出（例如 3月31日 减 1个月不变成 3月3日，而是取2月最后一天）
  if (d.getDate() !== currentDay) {
    d.setDate(0)
  }

  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * shared/recommendation/recall.js
 * 从技术画像生成结构化 GitHub 发现查询计划 (依据 project.md 第九节)
 */

export function planDiscoveryQueries(profile, recentQueries = [], now = Date.now()) {
  const queries = []
  if (!profile) return { queryPlan: [] }

  const topTopics = (profile.topInterests || []).map(i => i.tag).slice(0, 4)
  const topLanguages = Object.entries(profile.languages || {})
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang)
    .slice(0, 2)

  // 1. 主要兴趣 Topic + 主要语言组合
  if (topTopics.length > 0) {
    const mainTopic = topTopics[0]
    const mainLang = topLanguages[0] || null
    let q = `topic:${mainTopic} archived:false is:public`
    if (mainLang) {
      q += ` language:${mainLang}`
    }
    queries.push({
      id: `query_topic_${mainTopic}`,
      query: q,
      sort: 'stars',
      topics: [mainTopic],
      language: mainLang
    })
  }

  // 2. 次要兴趣 Topic 组合
  if (topTopics.length > 1) {
    const secondTopic = topTopics[1]
    queries.push({
      id: `query_topic_${secondTopic}`,
      query: `topic:${secondTopic} archived:false is:public`,
      sort: 'updated',
      topics: [secondTopic],
      language: null
    })
  }

  // 3. 第三或手选标签组合
  if (topTopics.length > 2) {
    const thirdTopic = topTopics[2]
    queries.push({
      id: `query_topic_${thirdTopic}`,
      query: `topic:${thirdTopic} archived:false is:public`,
      sort: 'stars',
      topics: [thirdTopic],
      language: null
    })
  }

  // 4. 若还不足 4 个，增加基于语言与趋势的查询
  if (queries.length < 4 && topLanguages.length > 0) {
    const lang = topLanguages[0]
    queries.push({
      id: `query_lang_${lang}`,
      query: `language:${lang} stars:>500 archived:false is:public`,
      sort: 'stars',
      topics: [],
      language: lang
    })
  }

  return {
    queryPlan: queries.slice(0, 4)
  }
}

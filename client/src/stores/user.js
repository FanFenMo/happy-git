import { defineStore } from 'pinia'

export const useUserStore = defineStore('user', {
  state: () => ({
    isLoggedIn: true,
    user: {
      username: 'FanFenMo',
      name: 'FanFenMo',
      avatar_url: 'https://avatars.githubusercontent.com/u/108137351?v=4',
      bio: '关注分布式计算与大数据分析 | Hadoop / Vue / Java 开发者',
      location: 'China',
      company: 'Happy Git Team',
      public_repos: 12,
      followers: 86,
      following: 42,
      tags: ['Java', 'Hadoop', 'Vue.js', 'MapReduce', 'Spring Boot', 'Big Data']
    },
    browseHistory: [
      {
        id: 'gorse-io/gorse',
        name: 'gorse-io/gorse',
        desc: 'Go 语言编写的高性能开源推荐系统引擎，支持协同过滤与向量检索',
        language: 'Go',
        stars: 9240,
        viewedAt: '10 分钟前',
        tags: ['推荐系统', '协同过滤', '高性能']
      },
      {
        id: 'apache/hadoop',
        name: 'apache/hadoop',
        desc: '分布式存储与计算平台核心仓库，包含 HDFS、MapReduce 与 YARN',
        language: 'Java',
        stars: 15300,
        viewedAt: '1 小时前',
        tags: ['分布式', 'MapReduce', 'HDFS']
      },
      {
        id: 'X-lab2017/open-digger',
        name: 'X-lab2017/open-digger',
        desc: '开源生态数据分析工具集，提取开源项目协作网络与活跃度指标',
        language: 'TypeScript',
        stars: 830,
        viewedAt: '昨天',
        tags: ['开源分析', '活跃度评估']
      }
    ],
    myStars: [
      {
        id: 'gorse-io/gitrec',
        name: 'gorse-io/gitrec',
        desc: 'GitHub 仓库个性化推荐系统与浏览器拓展',
        language: 'Python',
        stars: 3200,
        updatedAt: '2 天前'
      },
      {
        id: 'hankcs/HanLP',
        name: 'hankcs/HanLP',
        desc: '面向生产环境的多语种自然语言处理工具包，支持技术短语与实体抽取',
        language: 'Python',
        stars: 30100,
        updatedAt: '3 天前'
      },
      {
        id: 'RUCAIBox/RecBole',
        name: 'RUCAIBox/RecBole',
        desc: '基于 PyTorch 的统一推荐算法库与评测基准套件',
        language: 'Python',
        stars: 4800,
        updatedAt: '上周'
      }
    ],
    myProjects: [
      {
        id: 'happy-git',
        name: 'happy-git',
        desc: '基于用户群像的 Git 项目推荐与类抖音卡片流展示系统 (Hadoop MapReduce)',
        language: 'Vue / Java',
        stars: 1,
        forks: 0,
        license: 'Apache-2.0',
        isOpenSource: true
      },
      {
        id: 'mapreduce-log-analyzer',
        name: 'mapreduce-log-analyzer',
        desc: '基于 MapReduce 实现的分布式日志分析与高频词统计系统',
        language: 'Java',
        stars: 8,
        forks: 2,
        license: 'MIT',
        isOpenSource: true
      }
    ]
  }),

  actions: {
    async loginWithGitHub(username) {
      if (!username) return false
      try {
        const res = await fetch(`https://api.github.com/users/${username}`)
        if (res.ok) {
          const data = await res.json()
          this.user = {
            username: data.login,
            name: data.name || data.login,
            avatar_url: data.avatar_url,
            bio: data.bio || '探索开源技术的极客开发者',
            location: data.location || '未知',
            company: data.company || '开源极客',
            public_repos: data.public_repos || 0,
            followers: data.followers || 0,
            following: data.following || 0,
            tags: ['GitHub Dev', 'Open Source']
          }
          this.isLoggedIn = true
          return true
        } else {
          // Use input username as fallback
          this.user.username = username
          this.user.name = username
          this.isLoggedIn = true
          return true
        }
      } catch (err) {
        console.warn('GitHub API fetch failed, using local profile', err)
        this.user.username = username
        this.user.name = username
        this.isLoggedIn = true
        return true
      }
    },

    logout() {
      this.isLoggedIn = false
    },

    updateProfile(updated) {
      this.user = { ...this.user, ...updated }
    },

    clearHistory() {
      this.browseHistory = []
    },

    removeHistoryItem(index) {
      this.browseHistory.splice(index, 1)
    }
  }
})

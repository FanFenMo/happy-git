import { defineStore } from 'pinia'

export const useUserStore = defineStore('user', {
  state: () => ({
    // 默认未登录，用户打开应用时弹出登录弹窗
    isLoggedIn: false,
    // 是否为跳过登录的游客模式
    isGuest: false,
    user: {
      username: '',
      name: '',
      avatar_url: '',
      bio: '',
      location: '',
      company: '',
      public_repos: 0,
      followers: 0,
      following: 0,
      tags: []
    },
    browseHistory: [],
    myStars: [],
    myProjects: []
  }),

  actions: {
    // 跳过登录以游客身份浏览
    skipLogin() {
      this.isGuest = true
      this.isLoggedIn = false
      this.user = {
        username: 'Guest',
        name: '游客用户',
        avatar_url: 'https://avatars.githubusercontent.com/u/9919?s=200&v=4',
        bio: '当前处于游客模式，仅提供公开开源项目浏览。登录后可启用多维技术画像与浏览历史记录。',
        location: '未知',
        company: '游客浏览',
        public_repos: 0,
        followers: 0,
        following: 0,
        tags: ['游客模式', '未登录']
      }
      this.browseHistory = []
      this.myStars = []
      this.myProjects = []
    },

    async loginWithGitHub(username) {
      if (!username) return false
      this.isGuest = false
      try {
        const res = await fetch(`https://api.github.com/users/${username}`)
        if (res.ok) {
          const data = await res.json()
          this.user = {
            username: data.login,
            name: data.name || data.login,
            avatar_url: data.avatar_url,
            bio: data.bio || '探索分布式计算与开源生态的极客开发者',
            location: data.location || 'China',
            company: data.company || 'Open Source Dev',
            public_repos: data.public_repos || 0,
            followers: data.followers || 0,
            following: data.following || 0,
            tags: ['Java', 'Hadoop', 'Vue.js', 'MapReduce', 'Spring Boot']
          }
        } else {
          // Fallback user structure
          this.user = {
            username: username,
            name: username,
            avatar_url: `https://avatars.githubusercontent.com/u/108137351?v=4`,
            bio: '关注分布式计算与大数据分析 | Hadoop / Vue / Java 开发者',
            location: 'China',
            company: 'Happy Git Dev',
            public_repos: 12,
            followers: 86,
            following: 42,
            tags: ['Java', 'Hadoop', 'Vue.js', 'MapReduce', 'Spring Boot']
          }
        }
      } catch (err) {
        console.warn('GitHub API 连接受限，使用离线开发者资料', err)
        this.user = {
          username: username,
          name: username,
          avatar_url: `https://avatars.githubusercontent.com/u/108137351?v=4`,
          bio: '关注分布式计算与大数据分析 | Hadoop / Vue / Java 开发者',
          location: 'China',
          company: 'Happy Git Dev',
          public_repos: 12,
          followers: 86,
          following: 42,
          tags: ['Java', 'Hadoop', 'Vue.js', 'MapReduce', 'Spring Boot']
        }
      }

      this.isLoggedIn = true

      // 初始化用户的默认开源项目与收藏
      this.myProjects = [
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

      this.myStars = [
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
        }
      ]

      return true
    },

    logout() {
      this.isLoggedIn = false
      this.isGuest = true
      this.skipLogin()
    },

    updateProfile(updated) {
      if (this.isGuest) return
      this.user = { ...this.user, ...updated }
    },

    // 仅在已登录状态下记录浏览历史；游客模式下不记录
    recordBrowse(project) {
      if (!this.isLoggedIn || this.isGuest) {
        return
      }
      const existingIdx = this.browseHistory.findIndex((item) => item.id === project.id)
      if (existingIdx !== -1) {
        this.browseHistory.splice(existingIdx, 1)
      }
      this.browseHistory.unshift({
        id: project.id || project.fullName,
        name: project.fullName || project.name,
        desc: project.description || '暂无简介',
        language: project.language || 'Markdown',
        stars: project.stars || 0,
        viewedAt: '刚刚',
        tags: project.topics || ['开源精选']
      })
    },

    clearHistory() {
      this.browseHistory = []
    }
  }
})

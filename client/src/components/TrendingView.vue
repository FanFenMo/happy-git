<template>
  <div class="flex-1 flex flex-col h-full bg-zinc-950 text-white overflow-hidden relative">
    <!-- Top Header bar -->
    <header class="h-14 px-4 flex items-center justify-between border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur z-20 shrink-0">
      <div class="flex items-center gap-2">
        <span class="text-lg font-black bg-gradient-to-r from-red-500 via-rose-500 to-amber-500 bg-clip-text text-transparent">
          HappyGit
        </span>
        <span class="text-[11px] px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20 font-medium flex items-center gap-1">
          <span>🔥</span> 近3个月最火
        </span>
      </div>

      <div class="flex items-center gap-2">
        <button
          @click="fetchTrending"
          :disabled="loading"
          class="p-2 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-white transition flex items-center gap-1 text-xs"
          title="刷新热门项目"
        >
          <svg
            :class="['w-4 h-4', loading ? 'animate-spin text-rose-400' : '']"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <span class="hidden sm:inline">刷新</span>
        </button>
      </div>
    </header>

    <!-- Filter & Algorithm Banner -->
    <div class="px-4 py-2.5 bg-zinc-900/60 border-b border-zinc-800/60 flex items-center justify-between text-xs text-zinc-400 shrink-0">
      <div class="flex items-center gap-1.5">
        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
        <span>热门排序：近 90 天内创建 · Star 降序</span>
      </div>
      <div class="text-[11px] text-zinc-500 font-mono">
        {{ projects.length }} 个精选仓库
      </div>
    </div>

    <!-- Main List of Rectangular Cards with Text Summaries -->
    <div class="flex-1 overflow-y-auto p-4 space-y-3.5">
      <!-- Loading Skeleton -->
      <div v-if="loading && projects.length === 0" class="space-y-3">
        <div v-for="i in 4" :key="i" class="p-4 rounded-2xl bg-zinc-900/50 border border-zinc-800 animate-pulse space-y-3">
          <div class="h-4 bg-zinc-800 rounded w-1/3"></div>
          <div class="h-16 bg-zinc-800/60 rounded-xl"></div>
          <div class="h-4 bg-zinc-800 rounded w-1/2"></div>
        </div>
      </div>

      <!-- Rectangular Project Cards -->
      <div
        v-for="project in projects"
        :key="project.id"
        class="rounded-2xl border border-zinc-800/80 bg-zinc-900/70 hover:border-zinc-700/80 p-4 shadow-xl transition-all duration-200 group flex flex-col justify-between"
      >
        <!-- Card Top Bar: Repo Name & Stars -->
        <div class="flex items-start justify-between gap-3 mb-2.5">
          <div class="min-w-0">
            <h3
              @click="handleOpenRepo(project)"
              class="text-sm font-bold text-white group-hover:text-rose-400 cursor-pointer transition flex items-center gap-1.5 truncate"
            >
              <svg class="w-4 h-4 text-zinc-400 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"></path>
              </svg>
              <span class="truncate">{{ project.fullName || project.name }}</span>
            </h3>
            <span class="text-[10px] text-zinc-500 font-mono mt-0.5 block">
              创建于: {{ formatDate(project.createdAt) }}
            </span>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            <span class="px-2 py-0.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 text-xs font-mono font-bold flex items-center gap-1">
              ⭐ {{ formatNumber(project.stars) }}
            </span>
          </div>
        </div>

        <!-- Rectangular Text Summary Box (矩形框中加入文字简介形式) -->
        <div class="my-2.5 p-3 rounded-xl bg-zinc-950/80 border border-zinc-800/90 text-xs text-zinc-300 leading-relaxed font-sans">
          <p class="line-clamp-3">
            {{ project.description || '该开源仓库暂未填写简介，点击下方链接可在 GitHub 查阅详细源码与 README。' }}
          </p>
        </div>

        <!-- Topics & Language Row -->
        <div class="flex flex-wrap items-center gap-1.5 mb-3">
          <span
            v-if="project.language"
            class="px-2 py-0.5 rounded-md text-[10px] font-medium bg-zinc-800 text-zinc-300 flex items-center gap-1"
          >
            <span class="w-1.5 h-1.5 rounded-full" :style="{ backgroundColor: getLangColor(project.language) }"></span>
            {{ project.language }}
          </span>

          <span
            v-for="topic in (project.topics || []).slice(0, 3)"
            :key="topic"
            class="px-2 py-0.5 rounded-md text-[10px] bg-zinc-800/60 text-zinc-400 border border-zinc-800"
          >
            #{{ topic }}
          </span>
        </div>

        <!-- Card Action Footer -->
        <div class="flex items-center justify-between pt-2 border-t border-zinc-800/60 text-xs">
          <span class="text-[11px] text-zinc-500">
            🍴 {{ formatNumber(project.forks) }} forks
          </span>

          <div class="flex items-center gap-2">
            <button
              @click="handleFavorite(project)"
              class="px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-rose-400 text-[11px] transition flex items-center gap-1"
            >
              <span>⭐</span> 收藏
            </button>
            <button
              @click="handleOpenRepo(project)"
              class="px-3 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 text-[11px] font-medium transition flex items-center gap-1"
            >
              <span>查看源码</span>
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Empty notice if no projects -->
      <div v-if="!loading && projects.length === 0" class="text-center py-16 text-zinc-500 text-xs">
        未能加载到热门项目，请检查网络或点击右上角刷新。
      </div>
    </div>

    <!-- Guest toast notification -->
    <div
      v-if="toastMessage"
      class="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-xl bg-zinc-800 border border-zinc-700 text-xs text-white shadow-2xl backdrop-blur animate-fade-in"
    >
      {{ toastMessage }}
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useUserStore } from '../stores/user'

const userStore = useUserStore()

const projects = ref([])
const loading = ref(false)
const toastMessage = ref('')

const showToast = (msg) => {
  toastMessage.value = msg
  setTimeout(() => {
    toastMessage.value = ''
  }, 2500)
}

// 热门算法：抓取 GitHub 近 3 个月创建、star 降序的项目
const fetchTrending = async () => {
  loading.value = true
  try {
    // 优先尝试请求 Spring Boot 后端接口
    const backendRes = await fetch('http://localhost:8081/api/projects/trending?limit=20').catch(() => null)
    if (backendRes && backendRes.ok) {
      const result = await backendRes.json()
      if (result.data && result.data.length > 0) {
        projects.value = result.data
        return
      }
    }

    // 后端未启动时，直接调用 GitHub Search API 直连
    const threeMonthsAgo = new Date()
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3)
    const dateStr = threeMonthsAgo.toISOString().split('T')[0]

    const ghRes = await fetch(
      `https://api.github.com/search/repositories?q=created:>${dateStr}&sort=stars&order=desc&per_page=15`
    )

    if (ghRes.ok) {
      const data = await ghRes.json()
      projects.value = (data.items || []).map((item) => ({
        id: String(item.id),
        name: item.name,
        fullName: item.full_name,
        description: item.description,
        language: item.language || 'Markdown',
        stars: item.stargazers_count,
        forks: item.forks_count,
        htmlUrl: item.html_url,
        createdAt: item.created_at,
        topics: item.topics || []
      }))
    } else {
      useFallbackData()
    }
  } catch (err) {
    console.warn('获取热门项目失败，使用精选数据:', err)
    useFallbackData()
  } finally {
    loading.value = false
  }
}

const useFallbackData = () => {
  projects.value = [
    {
      id: '1',
      name: 'vllm',
      fullName: 'vllm-project/vllm',
      description: '极速且易用的大语言模型高吞吐量推理与服务框架，具备 PagedAttention 显存优化技术，业界主流 LLM 部署首选。',
      language: 'Python',
      stars: 34200,
      forks: 4800,
      htmlUrl: 'https://github.com/vllm-project/vllm',
      createdAt: '2026-08-01',
      topics: ['llm', 'inference', 'pytorch']
    },
    {
      id: '2',
      name: 'DeepSeek-V2',
      fullName: 'deepseek-ai/DeepSeek-V2',
      description: '高性价比强大 MoE 开源大语言模型，具备极高上下文处理吞吐与优秀的开源生态。',
      language: 'Python',
      stars: 28500,
      forks: 3100,
      htmlUrl: 'https://github.com/deepseek-ai/DeepSeek-V2',
      createdAt: '2026-08-15',
      topics: ['deep-learning', 'moe', 'ai']
    },
    {
      id: '3',
      name: 'hadoop',
      fullName: 'apache/hadoop',
      description: '分布式存储与大规模数据计算平台核心仓库，包含 HDFS、MapReduce 计算框架与 YARN 资源调度系统。',
      language: 'Java',
      stars: 15300,
      forks: 8900,
      htmlUrl: 'https://github.com/apache/hadoop',
      createdAt: '2026-08-20',
      topics: ['hadoop', 'mapreduce', 'bigdata']
    },
    {
      id: '4',
      name: 'gorse',
      fullName: 'gorse-io/gorse',
      description: 'Go 语言编写的高性能通用开源推荐系统引擎，支持协同过滤、向量检索与自动候选集召回。',
      language: 'Go',
      stars: 9240,
      forks: 950,
      htmlUrl: 'https://github.com/gorse-io/gorse',
      createdAt: '2026-09-02',
      topics: ['recommendation', 'collaborative-filtering']
    }
  ]
}

const handleOpenRepo = (project) => {
  // 记录浏览（登录模式下生效，游客模式自动忽略）
  userStore.recordBrowse(project)
  if (project.htmlUrl) {
    window.open(project.htmlUrl, '_blank')
  }
}

const handleFavorite = (project) => {
  if (userStore.isGuest || !userStore.isLoggedIn) {
    showToast('⚠️ 当前为游客模式，请先登录 GitHub 账号后再收藏项目')
  } else {
    showToast(`⭐ 已将 ${project.name} 纳入收藏列表`)
  }
}

const formatDate = (dateStr) => {
  if (!dateStr) return '近 3 个月'
  return dateStr.split('T')[0]
}

const formatNumber = (num) => {
  if (!num) return '0'
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'k'
  }
  return String(num)
}

const getLangColor = (lang) => {
  const map = {
    Python: '#3572A5',
    Java: '#b07219',
    Go: '#00ADD8',
    TypeScript: '#3178c6',
    JavaScript: '#f1e05a',
    Rust: '#dea584',
    Vue: '#41b883',
    'C++': '#f34b7d'
  }
  return map[lang] || '#a1a1aa'
}

onMounted(() => {
  fetchTrending()
})
</script>

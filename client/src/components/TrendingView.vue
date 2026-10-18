<template>
  <div class="flex-1 flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)] overflow-hidden relative">
    <!-- Top Header bar -->
    <header class="h-14 px-4 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)]/90 backdrop-blur z-20 shrink-0 no-select">
      <div class="flex items-center gap-2">
        <span class="text-lg font-black text-[var(--color-primary)]">
          HappyGit
        </span>
        <span class="text-[11px] px-2 py-0.5 rounded-full bg-[var(--color-surface-raised)] text-[var(--color-primary)] border border-[var(--color-border)] font-medium flex items-center gap-1">
          <span>🔥</span> 近 3 个月热门
        </span>
      </div>

      <div class="flex items-center gap-2">
        <button
          @click="() => fetchTrending(true)"
          :disabled="loading"
          class="p-2 rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)] hover:border-[var(--color-text-muted)] text-[var(--color-text-muted)] hover:text-white transition flex items-center gap-1 text-xs cursor-pointer"
          title="刷新热门项目"
        >
          <svg
            :class="['w-4 h-4', loading ? 'animate-spin text-[var(--color-primary)]' : '']"
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
    <div class="px-4 py-2.5 bg-[var(--color-surface)] border-b border-[var(--color-border)] flex items-center justify-between text-xs text-[var(--color-text-muted)] shrink-0 no-select">
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-[var(--color-success)]"></span>
        <span>近 3 个月创建 · 按 Star 降序</span>
        <span v-if="feedSource" class="text-[10px] text-[var(--color-text-subtle)]">
          ({{ sourceLabel(feedSource) }})
        </span>
      </div>
      <div class="text-[11px] text-[var(--color-text-subtle)] font-mono">
        {{ projects.length }} 个公开项目
      </div>
    </div>

    <!-- Main List of Rectangular Cards with Text Summaries -->
    <div class="flex-1 overflow-y-auto p-4 space-y-3.5 safe-area-bottom">
      <!-- Loading Skeleton -->
      <div v-if="loading && projects.length === 0" class="space-y-3">
        <div v-for="i in 4" :key="i" class="p-4 rounded-2xl card-surface animate-pulse space-y-3">
          <div class="h-4 bg-[var(--color-surface-raised)] rounded w-1/3"></div>
          <div class="h-16 bg-[var(--color-surface-raised)]/60 rounded-xl"></div>
          <div class="h-4 bg-[var(--color-surface-raised)] rounded w-1/2"></div>
        </div>
      </div>

      <!-- Rectangular Project Cards -->
      <div
        v-for="project in projects"
        :key="project.repoId"
        class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-text-subtle)] p-4 shadow-sm transition-all duration-200 group flex flex-col justify-between"
      >
        <!-- Card Top Bar: Repo Name & Stars -->
        <div class="flex items-start justify-between gap-3 mb-2.5">
          <div class="min-w-0">
            <h3
              @click="handleOpenRepo(project)"
              class="text-sm font-bold text-[var(--color-text)] group-hover:text-[var(--color-primary)] cursor-pointer transition flex items-center gap-1.5 truncate selectable"
            >
              <svg class="w-4 h-4 text-[var(--color-text-subtle)] shrink-0 no-select" fill="currentColor" viewBox="0 0 24 24">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"></path>
              </svg>
              <span class="truncate">{{ project.fullName || project.name }}</span>
            </h3>
            <span class="text-[10px] text-[var(--color-text-subtle)] font-mono mt-0.5 block no-select">
              创建于: {{ formatRepoDate(project.createdAt) }}
            </span>
          </div>

          <div class="flex items-center gap-2 shrink-0 no-select">
            <span class="px-2 py-0.5 rounded-lg bg-amber-500/10 text-[var(--color-star)] border border-amber-500/20 text-xs font-mono font-bold flex items-center gap-1">
              ⭐ {{ formatNumber(project.starCount) }}
            </span>
          </div>
        </div>

        <!-- Rectangular Text Summary Box -->
        <div class="my-2.5 p-3 rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)] text-xs text-[var(--color-text)] leading-relaxed font-sans selectable">
          <p class="line-clamp-3">
            {{ project.description || '该开源仓库暂未提供简介，点击下方链接可在 GitHub 查阅详细源码与 README。' }}
          </p>
        </div>

        <!-- Topics & Language Row -->
        <div class="flex flex-wrap items-center gap-1.5 mb-3 no-select">
          <span
            v-if="project.primaryLanguage && project.primaryLanguage !== '未标注'"
            class="px-2 py-0.5 rounded-md text-[10px] font-medium bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] flex items-center gap-1 border border-[var(--color-border)]"
          >
            <span class="w-1.5 h-1.5 rounded-full" :style="{ backgroundColor: getLangColor(project.primaryLanguage) }"></span>
            {{ project.primaryLanguage }}
          </span>

          <span
            v-for="topic in (project.topics || []).slice(0, 3)"
            :key="topic"
            class="px-2 py-0.5 rounded-md text-[10px] bg-[var(--color-surface-raised)] text-[var(--color-text-subtle)] border border-[var(--color-border)]"
          >
            #{{ topic }}
          </span>
        </div>

        <!-- Card Action Footer -->
        <div class="flex items-center justify-between pt-2 border-t border-[var(--color-border)] text-xs no-select">
          <span class="text-[11px] text-[var(--color-text-subtle)]">
            🍴 {{ formatNumber(project.forkCount) }} forks
          </span>

          <div class="flex items-center gap-2">
            <!-- Star / 已 Star 按钮 -->
            <button
              @click="toggleStar(project)"
              :disabled="userStore.starPendingByRepo[project.repoId]"
              class="px-3 py-1.5 rounded-xl border text-[11px] font-medium transition flex items-center gap-1.5 cursor-pointer"
              :class="[
                isRepoStarred(project)
                  ? 'bg-amber-500/15 border-amber-500/40 text-[var(--color-star)]'
                  : 'bg-[var(--color-surface-raised)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-white'
              ]"
            >
              <span v-if="userStore.starPendingByRepo[project.repoId]" class="w-3 h-3 border-2 border-[var(--color-star)] border-t-transparent rounded-full animate-spin"></span>
              <span v-else>{{ isRepoStarred(project) ? '★ 已 Star' : '☆ Star' }}</span>
            </button>

            <!-- 查看源码 -->
            <button
              @click="handleOpenRepo(project)"
              class="btn-primary px-3 py-1.5 !min-h-0 text-[11px] font-medium flex items-center gap-1 cursor-pointer"
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
      <div v-if="!loading && projects.length === 0" class="text-center py-16 text-[var(--color-text-subtle)] text-xs no-select">
        未能加载到符合条件的热门项目，请检查网络或点击右上角刷新。
      </div>
    </div>

    <!-- Toast notification -->
    <div
      v-if="toastMessage"
      class="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 px-4 py-2.5 rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)] text-xs text-[var(--color-text)] shadow-2xl backdrop-blur animate-fade-in no-select"
    >
      {{ toastMessage }}
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useUserStore } from '../stores/user'
import { loadTrending, openRepository } from '../services/projects'
import { getStarState } from '../services/account'

const emit = defineEmits(['request-login'])
const userStore = useUserStore()

const projects = ref([])
const loading = ref(false)
const feedSource = ref(null)
const toastMessage = ref('')
const starredMap = ref({})

const showToast = (msg) => {
  toastMessage.value = msg
  setTimeout(() => {
    toastMessage.value = ''
  }, 3000)
}

const sourceLabel = (source) => {
  switch (source) {
    case 'server':
      return '推荐服务实时'
    case 'github':
      return 'GitHub 直连'
    case 'cache':
      return '本地缓存'
    default:
      return source
  }
}

const isRepoStarred = (project) => {
  if (starredMap.value[project.repoId] !== undefined) {
    return starredMap.value[project.repoId]
  }
  // 也可根据 userStore.stars 判断
  return userStore.stars.some((r) => r.repoId === project.repoId)
}

const fetchTrending = async (force = false) => {
  loading.value = true
  try {
    const result = await loadTrending({ force })
    projects.value = result.items || []
    feedSource.value = result.source

    // 若已登录，异步查询列表中项目的 Star 状态
    if (userStore.hasAccount && projects.value.length > 0) {
      for (const p of projects.value) {
        getStarState(p).then((starred) => {
          starredMap.value[p.repoId] = starred
        })
      }
    }
  } catch (err) {
    console.warn('[TrendingView] 加载热门项目失败:', err)
    showToast('加载热门项目失败，请稍后重试')
  } finally {
    loading.value = false
  }
}

const handleOpenRepo = async (project) => {
  const result = await openRepository(project, 'trending', userStore.canRecordHistory)
  if (!result.opened) {
    showToast('打开仓库链接失败')
  }
}

const toggleStar = async (project) => {
  if (!userStore.canWriteGitHub) {
    showToast('⚠️ 当前处于未登录或游客模式，请先登录 GitHub 账号')
    emit('request-login')
    return
  }

  const currentlyStarred = isRepoStarred(project)
  const targetStarred = !currentlyStarred

  try {
    const res = await userStore.setStar(project, targetStarred)
    if (res.success) {
      starredMap.value[project.repoId] = targetStarred
      showToast(targetStarred ? `★ 已为 ${project.name} 添加 Star` : `☆ 已取消对 ${project.name} 的 Star`)
    } else {
      showToast(res.error || 'Star 操作未成功')
    }
  } catch (e) {
    showToast('Star 操作异常: ' + (e.message || '未知错误'))
  }
}

const formatRepoDate = (timestamp) => {
  if (!timestamp) return '近 3 个月'
  const d = new Date(timestamp)
  return isNaN(d.getTime()) ? '近 3 个月' : d.toISOString().split('T')[0]
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
    'C++': '#f34b7d',
    C: '#555555',
    Swift: '#F05138',
    Kotlin: '#A97BFF',
    Ruby: '#701516',
    PHP: '#4F5D95'
  }
  return map[lang] || '#8793A5'
}

onMounted(() => {
  fetchTrending(false)
})
</script>

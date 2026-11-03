<template>
  <div class="flex-1 flex flex-col bg-[var(--color-bg)] text-[var(--color-text)] relative">
    <!-- Top Header bar -->
    <header class="feed-toolbar flex items-center justify-between bg-[var(--color-surface)] shrink-0 no-select">
      <!-- 双页签切换 -->
      <div role="tablist" aria-label="项目浏览方式" class="flex items-center gap-1.5 p-1 rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)]">
        <button
          role="tab"
          :aria-selected="feedStore.isRecommendedTab"
          @click="switchTab('recommended')"
          :class="[
            'px-3 py-1 text-xs rounded-lg font-medium transition cursor-pointer',
            feedStore.isRecommendedTab
              ? 'bg-[var(--color-primary)] text-[var(--color-on-primary)] shadow'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          ]"
        >
          为你推荐
        </button>
        <button
          role="tab"
          :aria-selected="feedStore.isTrendingTab"
          @click="switchTab('trending')"
          :class="[
            'px-3 py-1 text-xs rounded-lg font-medium transition cursor-pointer',
            feedStore.isTrendingTab
              ? 'bg-[var(--color-primary)] text-[var(--color-on-primary)] shadow'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          ]"
        >
          热门项目
        </button>
      </div>

      <!-- 刷新按钮 -->
      <div class="flex items-center gap-2">
        <button
          @click="handleRefresh"
          :disabled="isLoading"
          class="p-2 rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)] hover:border-[var(--color-text-muted)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition flex items-center gap-1 text-xs cursor-pointer"
          title="刷新列表"
        >
          <svg
            :class="['w-4 h-4', isLoading ? 'animate-spin text-[var(--color-primary)]' : '']"
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

    <!-- Sub Header Status -->
    <div class="feed-summary py-3 bg-[var(--color-surface)] border-b border-[var(--color-border)] flex items-center justify-between text-xs text-[var(--color-text-muted)] shrink-0 no-select">
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full" :class="feedStore.isRecommendedTab ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-success)]'"></span>
        <span>{{ feedStore.isRecommendedTab ? '本地画像与技术标签排序' : '近 3 个月 GitHub 趋势' }}</span>
      </div>
      <div class="text-[11px] text-[var(--color-text-subtle)] font-mono">
        {{ currentList.length }} 个公开项目
      </div>
    </div>

    <!-- Main Content List -->
    <div class="feed-grid safe-area-bottom">
      <!-- Loading Skeleton -->
      <div v-if="isLoading && currentList.length === 0" class="feed-state space-y-3" role="status" aria-label="正在加载项目">
        <div v-for="i in 4" :key="i" class="p-4 rounded-2xl card-surface animate-pulse space-y-3">
          <div class="h-4 bg-[var(--color-surface-raised)] rounded w-1/3"></div>
          <div class="h-16 bg-[var(--color-surface-raised)]/60 rounded-xl"></div>
          <div class="h-4 bg-[var(--color-surface-raised)] rounded w-1/2"></div>
        </div>
      </div>

      <!-- Rectangular Project Cards -->
      <div
        v-for="item in currentList"
        :key="itemKey(item)"
        class="project-card border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-text-subtle)] transition-colors duration-150 group flex flex-col justify-between"
      >
        <!-- 推荐理由胶囊 (若有) -->
        <div v-if="item.reasons && item.reasons.length > 0" class="mb-2 flex flex-wrap items-center gap-1.5 no-select">
          <span
            v-for="(r, idx) in item.reasons"
            :key="idx"
            class="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-[var(--color-success)] border border-emerald-500/20 flex items-center gap-1"
          >
            <span>💡</span> {{ r }}
          </span>
        </div>

        <!-- Card Top Bar: Repo Name & Stars -->
        <div class="flex items-start justify-between gap-3 mb-2.5">
          <div class="min-w-0">
            <h3
              @click="handleOpenRepo(repoOf(item))"
              class="text-sm font-bold text-[var(--color-text)] group-hover:text-[var(--color-primary)] cursor-pointer transition flex items-center gap-1.5 truncate selectable"
            >
              <svg class="w-4 h-4 text-[var(--color-text-subtle)] shrink-0 no-select" fill="currentColor" viewBox="0 0 24 24">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"></path>
              </svg>
              <span class="truncate">{{ repoOf(item).fullName || repoOf(item).name }}</span>
            </h3>
            <span class="text-[10px] text-[var(--color-text-subtle)] font-mono mt-0.5 block no-select">
              {{ repoOf(item).updatedAt ? `更新于: ${formatRepoDate(repoOf(item).updatedAt)}` : '' }}
            </span>
          </div>

          <div class="flex items-center gap-2 shrink-0 no-select">
            <span class="px-2 py-0.5 rounded-lg bg-amber-500/10 text-[var(--color-star)] border border-amber-500/20 text-xs font-mono font-bold flex items-center gap-1">
              ⭐ {{ formatNumber(repoOf(item).starCount) }}
            </span>
          </div>
        </div>

        <!-- Rectangular Text Summary Box -->
        <div class="project-description my-2.5 text-[var(--color-text-muted)] font-sans selectable">
          <p class="line-clamp-3">
            {{ repoOf(item).description || '该开源仓库暂未提供简介，点击下方链接可在 GitHub 查阅详细源码与 README。' }}
          </p>
        </div>

        <!-- Topics & Language Row -->
        <div class="flex flex-wrap items-center gap-1.5 mb-3 no-select">
          <span
            v-if="repoOf(item).primaryLanguage && repoOf(item).primaryLanguage !== '未标注'"
            class="px-2 py-0.5 rounded-md text-[10px] font-medium bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] flex items-center gap-1 border border-[var(--color-border)]"
          >
            <span class="w-1.5 h-1.5 rounded-full" :style="{ backgroundColor: getLangColor(repoOf(item).primaryLanguage) }"></span>
            {{ repoOf(item).primaryLanguage }}
          </span>

          <span
            v-for="topic in (repoOf(item).topics || []).slice(0, 3)"
            :key="topic"
            class="px-2 py-0.5 rounded-md text-[10px] bg-[var(--color-surface-raised)] text-[var(--color-text-subtle)] border border-[var(--color-border)]"
          >
            #{{ topic }}
          </span>
        </div>

        <!-- Card Action Footer -->
        <div class="flex items-center justify-between pt-2 border-t border-[var(--color-border)] text-xs no-select">
          <span class="text-[11px] text-[var(--color-text-subtle)]">
            {{ repoOf(item).forkCount ? `🍴 ${formatNumber(repoOf(item).forkCount)} forks` : '' }}
          </span>

          <div class="flex items-center gap-2">
            <!-- 不感兴趣反馈 (仅推荐页展示) -->
            <button
              v-if="feedStore.isRecommendedTab"
              @click="handleHide(repoOf(item))"
              class="px-2 py-1 rounded-lg text-[10px] text-[var(--color-text-subtle)] hover:text-[var(--color-danger)] transition cursor-pointer"
              title="隐藏该项目，不作为兴趣推荐"
            >
              隐藏
            </button>

            <!-- Star 按钮 -->
            <button
              @click="toggleStar(repoOf(item))"
              :disabled="userStore.starPendingByRepo[repoOf(item).repoId || repoOf(item).canonicalKey]"
              class="px-3 py-1.5 rounded-xl border text-[11px] font-medium transition flex items-center gap-1.5 cursor-pointer"
              :class="[
                isRepoStarred(repoOf(item))
                  ? 'bg-amber-500/15 border-amber-500/40 text-[var(--color-star)]'
                  : 'bg-[var(--color-surface-raised)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
              ]"
            >
              <span v-if="userStore.starPendingByRepo[repoOf(item).repoId || repoOf(item).canonicalKey]" class="w-3 h-3 border-2 border-[var(--color-star)] border-t-transparent rounded-full animate-spin"></span>
              <span v-else>{{ isRepoStarred(repoOf(item)) ? '★ 已 Star' : '☆ Star' }}</span>
            </button>

            <!-- 查看源码 -->
            <button
              @click="handleOpenRepo(repoOf(item))"
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

      <!-- 加载更多推荐 (滚动分页) -->
      <div v-if="feedStore.isRecommendedTab && feedStore.recHasMore" class="feed-state text-center py-4">
        <button
          @click="feedStore.loadMoreRecommendations"
          :disabled="feedStore.recLoading"
          class="btn-secondary text-xs px-4 py-2 cursor-pointer"
        >
          {{ feedStore.recLoading ? '正在加载...' : '加载更多推荐' }}
        </button>
      </div>

      <!-- 空状态提示 -->
      <div v-if="!isLoading && currentList.length === 0" class="feed-state card-surface text-center py-16 px-6 no-select" role="status">
        <h2 class="text-base font-semibold mb-2">{{ feedStore.recError && feedStore.isRecommendedTab ? '推荐暂时无法生成' : '暂时没有可展示的项目' }}</h2>
        <p class="text-sm text-[var(--color-text-muted)] leading-relaxed">{{ feedStore.recError && feedStore.isRecommendedTab ? feedStore.recError : userStore.hasAccount ? '稍后刷新，或切换浏览方式继续探索。' : '游客可以浏览公开项目；连接 GitHub 后可使用个人兴趣推荐。' }}</p>
        <button v-if="!userStore.hasAccount" class="btn-primary px-4 text-sm mt-5" @click="$emit('request-login')">连接 GitHub</button>
        <button v-else class="btn-secondary px-4 text-sm mt-5" @click="handleRefresh">重新加载</button>
      </div>
    </div>

    <!-- Toast 提示消息 -->
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
import { useFeedStore } from '../stores/feed'
import { openRepository } from '../services/projects'

const emit = defineEmits(['request-login'])
const userStore = useUserStore()
const feedStore = useFeedStore()

const toastMessage = ref('')

const showToast = (msg) => {
  toastMessage.value = msg
  setTimeout(() => {
    toastMessage.value = ''
  }, 3000)
}

const isLoading = computed(() => {
  return feedStore.isRecommendedTab ? feedStore.recLoading : feedStore.trendingLoading
})

const currentList = computed(() => {
  return feedStore.isRecommendedTab ? feedStore.recItems : feedStore.trendingItems
})

function itemKey(item) {
  const r = repoOf(item)
  return r.repoId || r.canonicalKey || r.fullName
}

function repoOf(item) {
  return item.repository || item
}

function formatNumber(num) {
  if (num === null || num === undefined) return '—'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k'
  return String(num)
}

function formatRepoDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getLangColor(lang) {
  const colors = {
    Vue: '#41b883',
    JavaScript: '#f1e05a',
    TypeScript: '#3178c6',
    Python: '#3572A5',
    Java: '#b07219',
    Rust: '#dea584',
    Go: '#00ADD8',
    'C++': '#f34b7d',
    'C#': '#178600'
  }
  return colors[lang] || '#8E9EB2'
}

function isRepoStarred(repo) {
  const key = repo.repoId || repo.canonicalKey
  return userStore.stars.some(s => (s.repoId && s.repoId === key) || s.canonicalKey === repo.canonicalKey)
}

async function switchTab(tab) {
  feedStore.setTab(tab)
  if (tab === 'recommended' && feedStore.recItems.length === 0) {
    await feedStore.refreshRecommendations()
  } else if (tab === 'trending' && feedStore.trendingItems.length === 0) {
    await feedStore.loadTrendingFeed()
  }
}

async function handleRefresh() {
  if (feedStore.isRecommendedTab) {
    await feedStore.refreshRecommendations()
  } else {
    await feedStore.loadTrendingFeed({ force: true })
  }
}

async function handleOpenRepo(repo) {
  const result = await openRepository(repo, feedStore.activeTab, userStore.canRecordHistory)
  if (!result.opened) {
    showToast('打开仓库链接失败')
  }
}

async function toggleStar(repo) {
  if (!userStore.canWriteGitHub) {
    showToast('请先登录 GitHub 账号后操作')
    emit('request-login')
    return
  }

  const currentlyStarred = isRepoStarred(repo)
  const desired = !currentlyStarred

  try {
    const res = await userStore.setStar(repo, desired)
    if (res.confirmed) {
      showToast(desired ? '⭐ Star 成功' : '已取消 Star')
    } else if (res.state === 'uncertain') {
      showToast('⚠️ 操作已发出，正在复核远端状态...')
    }
  } catch (err) {
    showToast(err.message || 'Star 操作失败')
  }
}

async function handleHide(repo) {
  const key = repo.repoId || repo.canonicalKey
  await feedStore.hideRecommendation(key)
  showToast('已隐藏该项目，画像将调整')
}

onMounted(() => {
  if (userStore.hasAccount) {
    feedStore.refreshRecommendations()
  } else {
    feedStore.loadTrendingFeed()
  }
})
</script>

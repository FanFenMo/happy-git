<template>
  <div class="flex-1 min-w-0 flex flex-col bg-[var(--color-bg)] text-[var(--color-text)] relative">
    <header class="feed-toolbar flex flex-wrap items-center justify-between gap-3 bg-[var(--color-surface)] shrink-0 no-select">
      <div role="group" aria-label="项目浏览方式" class="feed-switcher flex items-center gap-1 p-1 rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)]">
        <button
          type="button"
          :aria-pressed="feedStore.isRecommendedTab"
          aria-controls="project-feed"
          @click="switchTab('recommended')"
          :class="[
            'px-3 py-2 text-sm rounded-lg font-medium transition cursor-pointer',
            feedStore.isRecommendedTab
              ? 'bg-[var(--color-primary)] text-[var(--color-on-primary)] shadow'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          ]"
        >为你推荐</button>
        <button
          type="button"
          :aria-pressed="feedStore.isTrendingTab"
          aria-controls="project-feed"
          @click="switchTab('trending')"
          :class="[
            'px-3 py-2 text-sm rounded-lg font-medium transition cursor-pointer',
            feedStore.isTrendingTab
              ? 'bg-[var(--color-primary)] text-[var(--color-on-primary)] shadow'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          ]"
        >热门项目</button>
      </div>

      <button
        type="button"
        @click="handleRefresh"
        :disabled="isLoading"
        :aria-busy="isLoading"
        aria-label="刷新项目列表"
        class="icon-button rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition flex items-center justify-center gap-2 text-sm cursor-pointer"
        title="刷新列表"
      >
        <RefreshCw :class="['w-[18px] h-[18px]', isLoading ? 'animate-spin text-[var(--color-primary)]' : '']" aria-hidden="true" />
        <span class="hidden sm:inline">刷新</span>
      </button>
    </header>

    <div class="feed-summary py-3 bg-[var(--color-surface)] border-b border-[var(--color-border)] flex flex-wrap items-center justify-between gap-2 text-[13px] text-[var(--color-text-muted)] shrink-0 no-select">
      <div class="flex items-center gap-2 min-w-0">
        <span aria-hidden="true" class="w-2 h-2 rounded-full shrink-0" :class="feedStore.isRecommendedTab ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-success)]'"></span>
        <span>{{ feedStore.isRecommendedTab ? '本地画像与技术标签排序' : '近 3 个月 GitHub 趋势' }}</span>
      </div>
      <span class="text-[var(--color-text-subtle)] tabular-nums">{{ currentList.length }} 个公开项目</span>
    </div>

    <section id="project-feed" :aria-label="feedStore.isRecommendedTab ? '为你推荐的项目' : '热门项目'" :aria-busy="isLoading" class="feed-grid safe-area-bottom">
      <div v-if="isLoading && currentList.length === 0" class="feed-state space-y-3" role="status" aria-label="正在加载项目">
        <div v-for="i in 4" :key="i" aria-hidden="true" class="p-4 rounded-2xl card-surface animate-pulse space-y-3">
          <div class="h-4 bg-[var(--color-surface-raised)] rounded w-1/3"></div>
          <div class="h-16 bg-[var(--color-surface-raised)] rounded-xl"></div>
          <div class="h-4 bg-[var(--color-surface-raised)] rounded w-1/2"></div>
        </div>
      </div>

      <article
        v-for="item in currentList"
        :key="itemKey(item)"
        class="project-card border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-text-subtle)] transition-colors duration-150 group flex flex-col"
      >
        <div v-if="item.reasons && item.reasons.length > 0" class="mb-3 flex flex-wrap items-center gap-2 no-select" aria-label="推荐理由">
          <span
            v-for="(r, idx) in item.reasons"
            :key="idx"
            class="px-2.5 py-1 rounded-full text-[13px] font-medium bg-emerald-500/10 text-[var(--color-success)] border border-emerald-500/20 inline-flex items-center gap-1.5 max-w-full [overflow-wrap:anywhere]"
          >
            <Lightbulb class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            {{ r }}
          </span>
        </div>

        <div class="project-card-header flex flex-wrap items-start justify-between gap-3 mb-2.5">
          <div class="min-w-0 flex-1">
            <h3 class="min-w-0 text-base font-semibold text-[var(--color-text)]">
              <button
                type="button"
                @click="handleOpenRepo(repoOf(item))"
                :aria-label="`在 GitHub 打开 ${repoOf(item).fullName || repoOf(item).name}`"
                class="project-title flex items-start gap-2 text-left w-full min-w-0 group-hover:text-[var(--color-primary)] transition cursor-pointer"
              >
                <FolderGit2 class="w-[18px] h-[18px] mt-0.5 text-[var(--color-text-subtle)] shrink-0" aria-hidden="true" />
                <span class="min-w-0 break-words [overflow-wrap:anywhere] selectable">{{ repoOf(item).fullName || repoOf(item).name }}</span>
              </button>
            </h3>
            <span v-if="repoOf(item).updatedAt" class="text-[13px] text-[var(--color-text-subtle)] mt-1 block no-select">
              更新于 {{ formatRepoDate(repoOf(item).updatedAt) }}
            </span>
          </div>
          <span class="px-2.5 py-1 rounded-lg bg-amber-500/10 text-[var(--color-star)] border border-amber-500/20 text-[13px] tabular-nums font-medium inline-flex items-center gap-1.5 shrink-0 no-select" :aria-label="`${repoOf(item).starCount ?? 0} 个 Star`">
            <Star class="w-3.5 h-3.5" aria-hidden="true" />
            {{ formatNumber(repoOf(item).starCount) }}
          </span>
        </div>

        <div class="project-description my-2.5 text-[15px] leading-relaxed text-[var(--color-text-muted)] selectable">
          <p class="line-clamp-3 break-words [overflow-wrap:anywhere]">
            {{ repoOf(item).description || '该仓库暂未提供简介，可在 GitHub 查看源码与 README。' }}
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-2 mb-4 no-select">
          <span
            v-if="repoOf(item).primaryLanguage && repoOf(item).primaryLanguage !== '未标注'"
            class="px-2.5 py-1 rounded-md text-[13px] font-medium bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] inline-flex items-center gap-1.5 border border-[var(--color-border)] max-w-full break-words"
          >
            <span aria-hidden="true" class="w-1.5 h-1.5 rounded-full shrink-0" :style="{ backgroundColor: getLangColor(repoOf(item).primaryLanguage) }"></span>
            {{ repoOf(item).primaryLanguage }}
          </span>
          <span
            v-for="topic in (repoOf(item).topics || []).slice(0, 3)"
            :key="topic"
            class="px-2.5 py-1 rounded-md text-[13px] bg-[var(--color-surface-raised)] text-[var(--color-text-subtle)] border border-[var(--color-border)] max-w-full [overflow-wrap:anywhere]"
          >#{{ topic }}</span>
        </div>

        <footer class="project-actions flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-[var(--color-border)] text-[13px] no-select">
          <span v-if="repoOf(item).forkCount" class="text-[var(--color-text-subtle)] inline-flex items-center gap-1.5 tabular-nums">
            <GitFork class="w-4 h-4" aria-hidden="true" />
            {{ formatNumber(repoOf(item).forkCount) }} forks
          </span>
          <div class="flex flex-wrap items-center gap-2 ml-auto">
            <button
              v-if="feedStore.isRecommendedTab"
              type="button"
              @click="handleHide(repoOf(item))"
              :aria-label="`隐藏 ${repoOf(item).fullName || repoOf(item).name}，不再推荐`"
              class="px-3 py-2 rounded-xl text-sm text-[var(--color-text-subtle)] hover:text-[var(--color-danger)] transition cursor-pointer"
              title="隐藏该项目，不作为兴趣推荐"
            >隐藏</button>
            <button
              type="button"
              @click="toggleStar(repoOf(item))"
              :disabled="userStore.starPendingByRepo[repoOf(item).repoId || repoOf(item).canonicalKey]"
              :aria-busy="!!userStore.starPendingByRepo[repoOf(item).repoId || repoOf(item).canonicalKey]"
              :aria-pressed="isRepoStarred(repoOf(item))"
              :aria-label="`${isRepoStarred(repoOf(item)) ? '取消 Star' : 'Star'} ${repoOf(item).fullName || repoOf(item).name}`"
              class="px-3 py-2 rounded-xl border text-sm font-medium transition inline-flex items-center justify-center gap-2 cursor-pointer"
              :class="[
                isRepoStarred(repoOf(item))
                  ? 'bg-amber-500/15 border-amber-500/40 text-[var(--color-star)]'
                  : 'bg-[var(--color-surface-raised)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
              ]"
            >
              <LoaderCircle v-if="userStore.starPendingByRepo[repoOf(item).repoId || repoOf(item).canonicalKey]" class="w-4 h-4 animate-spin" aria-hidden="true" />
              <Star v-else class="w-4 h-4" :fill="isRepoStarred(repoOf(item)) ? 'currentColor' : 'none'" aria-hidden="true" />
              <span>{{ isRepoStarred(repoOf(item)) ? '已 Star' : 'Star' }}</span>
            </button>
            <button
              type="button"
              @click="handleOpenRepo(repoOf(item))"
              :aria-label="`查看 ${repoOf(item).fullName || repoOf(item).name} 的源码`"
              class="btn-primary px-3 py-2 text-sm font-medium inline-flex items-center justify-center gap-2 cursor-pointer"
            >
              <span>查看源码</span>
              <ExternalLink class="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </footer>
      </article>

      <div v-if="feedStore.isRecommendedTab && feedStore.recHasMore" class="feed-state text-center py-4">
        <button
          type="button"
          @click="feedStore.loadMoreRecommendations"
          :disabled="feedStore.recLoading"
          :aria-busy="feedStore.recLoading"
          class="btn-secondary text-sm px-4 py-2 cursor-pointer"
        >{{ feedStore.recLoading ? '正在加载…' : '加载更多推荐' }}</button>
      </div>

      <div v-if="!isLoading && currentList.length === 0" class="feed-state card-surface text-center py-16 px-6 no-select" role="status">
        <h2 class="text-base font-semibold mb-2">{{ feedStore.recError && feedStore.isRecommendedTab ? '推荐暂时无法生成' : '暂时没有可展示的项目' }}</h2>
        <p class="text-sm text-[var(--color-text-muted)] leading-relaxed">{{ feedStore.recError && feedStore.isRecommendedTab ? feedStore.recError : userStore.hasAccount ? '稍后刷新，或切换浏览方式继续探索。' : '游客可以浏览公开项目；连接 GitHub 后可使用个人兴趣推荐。' }}</p>
        <button v-if="!userStore.hasAccount" type="button" class="btn-primary px-4 text-sm mt-5" @click="$emit('request-login')">连接 GitHub</button>
        <button v-else type="button" class="btn-secondary px-4 text-sm mt-5" @click="handleRefresh">重新加载</button>
      </div>
    </section>

    <div
      v-if="toastMessage"
      role="status"
      aria-live="polite"
      class="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 max-w-[calc(100%_-_2rem)] px-4 py-3 rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)] text-sm text-[var(--color-text)] shadow-2xl backdrop-blur animate-fade-in no-select"
    >{{ toastMessage }}</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ExternalLink, FolderGit2, GitFork, Lightbulb, LoaderCircle, RefreshCw, Star } from 'lucide-vue-next'
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
      showToast(desired ? 'Star 成功' : '已取消 Star')
    } else if (res.state === 'uncertain') {
      showToast('操作已发出，正在复核远端状态…')
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

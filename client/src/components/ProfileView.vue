<template>
  <div class="flex-1 flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)] overflow-y-auto safe-area-bottom">
    <!-- Top Cover & Header -->
    <div class="relative bg-gradient-to-b from-[var(--color-surface)] to-[var(--color-bg)] pt-6 px-4 pb-4 border-b border-[var(--color-border)] no-select">
      <!-- Top Utility Bar -->
      <div class="relative z-10 flex items-center justify-between mb-4">
        <div class="flex items-center gap-2 text-xs">
          <span
            class="w-2 h-2 rounded-full"
            :class="[
              userStore.needsReauth ? 'bg-[var(--color-danger)]' :
              userStore.isOffline ? 'bg-amber-400' :
              userStore.hasAccount ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-subtle)]'
            ]"
          ></span>
          <span class="text-[var(--color-text-muted)]">
            {{
              userStore.needsReauth ? '授权已失效' :
              userStore.isOffline ? '离线模式' :
              userStore.hasAccount ? 'GitHub 已连接' : '游客模式 (只读)'
            }}
          </span>
        </div>

        <div class="flex items-center gap-2">
          <button
            v-if="!userStore.hasAccount"
            @click="$emit('open-login')"
            class="px-3 py-1 rounded-full btn-primary text-xs !min-h-0 cursor-pointer"
          >
            <span>登录</span>
          </button>
          <button
            v-else
            @click="refreshData"
            :disabled="isRefreshing"
            class="p-2 rounded-full bg-[var(--color-surface-raised)] border border-[var(--color-border)] hover:border-[var(--color-text-muted)] text-[var(--color-text-muted)] hover:text-white transition cursor-pointer"
            title="刷新个人数据"
          >
            <svg :class="['w-4 h-4', isRefreshing ? 'animate-spin text-[var(--color-primary)]' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            @click="$emit('open-settings')"
            class="p-2 rounded-full bg-[var(--color-surface-raised)] border border-[var(--color-border)] hover:border-[var(--color-text-muted)] text-[var(--color-text-muted)] hover:text-white transition cursor-pointer"
            title="应用设置"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Reauth Notice Banner if token expired -->
      <div
        v-if="userStore.needsReauth"
        class="relative z-10 mb-4 p-3 rounded-2xl bg-red-950/40 border border-[var(--color-danger)] flex items-center justify-between gap-3 text-xs"
      >
        <div class="text-[var(--color-danger)]">
          <div class="font-bold">授权已失效</div>
          <div class="text-[11px] text-[var(--color-danger)]/80">需要重新授权以同步最新公开仓库与 Star</div>
        </div>
        <button
          @click="$emit('open-login')"
          class="px-3 py-1.5 rounded-xl btn-primary text-xs !min-h-0 cursor-pointer"
        >
          重新授权
        </button>
      </div>

      <!-- Guest Warning Banner if in Guest Mode -->
      <div
        v-else-if="!userStore.hasAccount"
        class="relative z-10 mb-4 p-3 rounded-2xl bg-[var(--color-surface-raised)] border border-[var(--color-border)] flex items-center justify-between gap-3 text-xs"
      >
        <div>
          <div class="font-bold text-[var(--color-text)]">当前为游客模式</div>
          <div class="text-[11px] text-[var(--color-text-muted)]">登录后可同步公开项目、自定义技术兴趣并记录本机历史</div>
        </div>
        <button
          @click="$emit('open-login')"
          class="px-3 py-1.5 rounded-xl btn-primary text-xs !min-h-0 cursor-pointer shrink-0"
        >
          登录账号
        </button>
      </div>

      <!-- Avatar & Basic Info -->
      <div class="relative z-10 flex items-start gap-4 mb-4">
        <div class="relative">
          <img
            :src="avatarUrl"
            alt="User Avatar"
            class="w-16 h-16 rounded-full object-cover border-2 border-[var(--color-primary)] shadow-md"
          />
        </div>

        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <h2 class="text-lg font-bold text-[var(--color-text)] truncate selectable">
              {{ profile?.displayName || profile?.login || (userStore.hasAccount ? '已保存账号' : '游客用户') }}
            </h2>
          </div>
          <div v-if="profile?.login" class="text-xs text-[var(--color-text-subtle)] font-mono mt-0.5 selectable">
            @{{ profile.login }}
          </div>
          <div v-if="userStore.hasAccount" class="text-xs text-[var(--color-text-muted)] mt-1.5 flex flex-wrap items-center gap-3 selectable">
            <span v-if="profile?.location">📍 {{ profile.location }}</span>
            <span v-if="profile?.company">🏢 {{ profile.company }}</span>
          </div>
        </div>
      </div>

      <!-- Bio / Profile Statement -->
      <p class="relative z-10 text-xs text-[var(--color-text-muted)] leading-relaxed mb-4 selectable">
        {{ profile?.bio || (userStore.hasAccount ? '暂未填写个人简介' : '游客模式仅提供公开热门开源项目浏览，未开启个人浏览历史与同步。') }}
      </p>

      <!-- Technical Interest Tags (技术兴趣) -->
      <div class="relative z-10 mb-4">
        <div class="flex items-center justify-between text-[11px] text-[var(--color-text-muted)] font-semibold mb-2">
          <span>技术兴趣 (根据公开仓库与 Star 归纳)</span>
          <button
            v-if="userStore.hasAccount"
            @click="$emit('edit-profile')"
            class="text-[var(--color-primary)] hover:underline cursor-pointer"
          >
            兴趣设置
          </button>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="tag in interestTags"
            :key="tag"
            class="px-2.5 py-1 rounded-lg text-xs card-raised border border-[var(--color-border)] text-[var(--color-text)] transition"
          >
            # {{ tag }}
          </span>
          <span
            v-if="interestTags.length === 0"
            class="text-[11px] text-[var(--color-text-subtle)] italic py-1"
          >
            {{ userStore.hasAccount ? '暂未归纳出技术兴趣，可点击“兴趣设置”手动添加' : '登录后将基于公开仓库与 Star 自动提取' }}
          </span>
        </div>
      </div>

      <!-- Stats Bar -->
      <div class="relative z-10 grid grid-cols-4 gap-2 py-3 px-2 rounded-2xl card-raised border border-[var(--color-border)] text-center mb-3">
        <div>
          <div class="text-sm font-bold text-[var(--color-text)] font-mono">
            {{ userStore.hasAccount ? (profile?.publicRepoCount ?? userStore.repos.length) : '-' }}
          </div>
          <div class="text-[11px] text-[var(--color-text-muted)]">公开项目</div>
        </div>
        <div>
          <div class="text-sm font-bold text-[var(--color-text)] font-mono">
            {{ userStore.hasAccount ? starCountDisplay : '-' }}
          </div>
          <div class="text-[11px] text-[var(--color-text-muted)]">我的 Star</div>
        </div>
        <div>
          <div class="text-sm font-bold text-[var(--color-text)] font-mono">
            {{ userStore.hasAccount ? (profile?.followerCount ?? 0) : '-' }}
          </div>
          <div class="text-[11px] text-[var(--color-text-muted)]">关注者</div>
        </div>
        <div>
          <div class="text-sm font-bold text-[var(--color-text)] font-mono">
            {{ userStore.hasAccount ? (profile?.followingCount ?? 0) : '-' }}
          </div>
          <div class="text-[11px] text-[var(--color-text-muted)]">正在关注</div>
        </div>
      </div>
    </div>

    <!-- Sub-Tab Bar -->
    <div class="sticky top-0 z-20 bg-[var(--color-bg)]/95 backdrop-blur border-b border-[var(--color-border)] flex text-center no-select">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        @click="activeTab = tab.id"
        :class="[
          'flex-1 py-3 text-xs font-bold transition relative cursor-pointer',
          activeTab === tab.id ? 'text-[var(--color-text)]' : 'text-[var(--color-text-subtle)] hover:text-[var(--color-text-muted)]'
        ]"
      >
        <span>{{ tab.label }}</span>
        <span v-if="userStore.hasAccount && tab.count !== undefined" class="text-[10px] ml-1 opacity-70">
          ({{ tab.count }})
        </span>
        <div
          v-if="activeTab === tab.id"
          class="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-[var(--color-primary)] rounded-full"
        ></div>
      </button>
    </div>

    <!-- Tab Content -->
    <div class="flex-1 p-4">
      <!-- 1. 浏览历史 -->
      <div v-if="activeTab === 'history'" class="space-y-3">
        <div v-if="userStore.hasAccount">
          <!-- 搜索与清空工具栏 -->
          <div class="flex items-center gap-2 mb-3 no-select">
            <div class="flex-1 relative">
              <input
                v-model="historyKeyword"
                @input="handleHistorySearch"
                type="text"
                placeholder="搜索已访问仓库名称或简介..."
                class="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl px-3 py-2 text-xs text-[var(--color-text)] focus:outline-none focus:border-[var(--color-primary)] transition"
              />
              <span v-if="historyKeyword" @click="clearSearch" class="absolute right-2.5 top-2 text-xs text-[var(--color-text-subtle)] hover:text-white cursor-pointer">✕</span>
            </div>
            <button
              v-if="historyStore.items.length > 0"
              @click="confirmClearHistory"
              class="px-2.5 py-2 text-xs text-[var(--color-danger)] hover:bg-red-950/20 rounded-xl transition cursor-pointer"
            >
              清空
            </button>
          </div>

          <!-- 历史列表 -->
          <div class="space-y-2.5">
            <div
              v-for="item in historyStore.items"
              :key="item.repoId"
              class="p-3.5 rounded-2xl card-surface hover:border-[var(--color-text-subtle)] transition flex flex-col justify-between"
            >
              <div class="flex items-start justify-between gap-2 mb-1.5">
                <h4
                  @click="openRepo(item.repository || item, 'history')"
                  class="text-sm font-bold text-[var(--color-text)] hover:text-[var(--color-primary)] cursor-pointer truncate selectable"
                >
                  {{ item.fullName }}
                </h4>
                <div class="flex items-center gap-2 shrink-0 no-select">
                  <span class="text-[10px] text-[var(--color-text-subtle)] font-mono">
                    {{ formatHistoryTime(item.lastViewedAt) }}
                  </span>
                  <button
                    @click="deleteHistoryItem(item.repoId)"
                    class="text-xs text-[var(--color-text-subtle)] hover:text-[var(--color-danger)] transition cursor-pointer"
                    title="删除单条记录"
                  >
                    🗑
                  </button>
                </div>
              </div>

              <p class="text-xs text-[var(--color-text-muted)] line-clamp-2 mb-2 selectable">
                {{ item.description || '暂无描述' }}
              </p>

              <div class="flex items-center justify-between text-[11px] text-[var(--color-text-subtle)] no-select">
                <div class="flex items-center gap-3">
                  <span v-if="item.repository?.primaryLanguage">
                    {{ item.repository.primaryLanguage }}
                  </span>
                  <span v-if="item.repository?.starCount">
                    ⭐ {{ item.repository.starCount }}
                  </span>
                </div>
                <span class="text-[10px]">访问 {{ item.visitCount }} 次</span>
              </div>
            </div>
          </div>

          <!-- 加载更多历史 -->
          <div v-if="historyStore.hasMore" class="pt-3 text-center no-select">
            <button
              @click="historyStore.loadMore"
              :disabled="historyStore.isLoadingMore"
              class="px-4 py-2 rounded-xl btn-secondary text-xs cursor-pointer"
            >
              {{ historyStore.isLoadingMore ? '加载中...' : '加载更多历史' }}
            </button>
          </div>

          <div v-if="!historyStore.isLoading && historyStore.items.length === 0" class="py-12 text-center text-xs text-[var(--color-text-subtle)] no-select">
            {{ historyKeyword ? '未找到符合条件的浏览历史' : '暂无浏览记录，在热门页点击仓库即可记录' }}
          </div>
        </div>

        <!-- Guest state for history -->
        <div v-else class="py-16 text-center space-y-3 no-select">
          <div class="w-12 h-12 mx-auto rounded-2xl card-raised border border-[var(--color-border)] flex items-center justify-center text-xl text-[var(--color-text-subtle)]">
            🛡️
          </div>
          <div class="text-sm font-bold text-[var(--color-text)]">游客模式不记录浏览历史</div>
          <p class="text-xs text-[var(--color-text-muted)] max-w-xs mx-auto">
            登录 GitHub 账号后，在端内查看开源项目会自动记录到本机 SQLite，仅保存在当前设备。
          </p>
          <button
            @click="$emit('open-login')"
            class="px-4 py-2 rounded-xl btn-primary text-xs cursor-pointer"
          >
            立即登录以开启历史
          </button>
        </div>
      </div>

      <!-- 2. 我的 Star -->
      <div v-if="activeTab === 'stars'" class="space-y-3">
        <div v-if="userStore.hasAccount">
          <!-- 同步状态提示 -->
          <div class="flex items-center justify-between text-xs text-[var(--color-text-subtle)] pb-1 no-select">
            <span>
              {{ userStore.starSync.complete ? `已完整同步 (共 ${userStore.stars.length} 项)` : `已加载 ${userStore.stars.length} 项 (同步中)` }}
            </span>
          </div>

          <div class="space-y-2.5">
            <div
              v-for="repo in userStore.stars"
              :key="repo.repoId"
              class="p-3.5 rounded-2xl card-surface hover:border-[var(--color-text-subtle)] transition flex flex-col justify-between"
            >
              <div class="flex items-start justify-between gap-2 mb-1">
                <h4
                  @click="openRepo(repo, 'star')"
                  class="text-sm font-bold text-[var(--color-text)] hover:text-[var(--color-primary)] cursor-pointer truncate selectable"
                >
                  {{ repo.fullName || repo.name }}
                </h4>
                <div class="flex items-center gap-2 shrink-0 no-select">
                  <span class="text-[var(--color-star)] text-xs font-mono font-medium">
                    ⭐ {{ repo.starCount }}
                  </span>
                  <button
                    @click="unstarRepo(repo)"
                    class="text-[11px] px-2 py-0.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition cursor-pointer"
                  >
                    取消 Star
                  </button>
                </div>
              </div>

              <p class="text-xs text-[var(--color-text-muted)] line-clamp-2 mb-2 selectable">
                {{ repo.description || '暂无描述' }}
              </p>

              <div class="flex items-center justify-between text-[10px] text-[var(--color-text-subtle)] no-select">
                <span>{{ repo.primaryLanguage || '未标注' }}</span>
                <span>{{ repo.updatedAt ? `更新于 ${new Date(repo.updatedAt).toLocaleDateString()}` : '' }}</span>
              </div>
            </div>
          </div>

          <div v-if="userStore.stars.length === 0" class="py-12 text-center text-xs text-[var(--color-text-subtle)] no-select">
            {{ userStore.starSync.status === 'loading' ? '正在拉取 Star 列表...' : '暂无公开 Star 仓库' }}
          </div>
        </div>

        <!-- Guest state for stars -->
        <div v-else class="py-16 text-center space-y-3 no-select">
          <div class="w-12 h-12 mx-auto rounded-2xl card-raised border border-[var(--color-border)] flex items-center justify-center text-xl text-[var(--color-text-subtle)]">
            ⭐
          </div>
          <div class="text-sm font-bold text-[var(--color-text)]">登录同步 GitHub Star</div>
          <p class="text-xs text-[var(--color-text-muted)] max-w-xs mx-auto">
            登录后即可在此查看与管理您在 GitHub 上 Star 过的所有公开项目。
          </p>
          <button
            @click="$emit('open-login')"
            class="px-4 py-2 rounded-xl btn-primary text-xs cursor-pointer"
          >
            立即登录同步
          </button>
        </div>
      </div>

      <!-- 3. 我的项目 -->
      <div v-if="activeTab === 'projects'" class="space-y-3">
        <div v-if="userStore.hasAccount">
          <div class="space-y-2.5">
            <div
              v-for="proj in userStore.repos"
              :key="proj.repoId"
              class="p-3.5 rounded-2xl card-surface hover:border-[var(--color-text-subtle)] transition flex flex-col justify-between"
            >
              <div class="flex items-start justify-between gap-2 mb-1.5">
                <div class="flex items-center gap-2 truncate">
                  <h4
                    @click="openRepo(proj, 'owned')"
                    class="text-sm font-bold text-[var(--color-text)] hover:text-[var(--color-primary)] cursor-pointer truncate selectable"
                  >
                    {{ proj.name }}
                  </h4>
                  <span v-if="proj.isFork" class="px-1.5 py-0.5 rounded text-[10px] bg-[var(--color-surface-raised)] border border-[var(--color-border)] text-[var(--color-text-subtle)] shrink-0 no-select">
                    Fork
                  </span>
                  <span v-if="proj.licenseSpdx" class="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/10 text-[var(--color-success)] border border-emerald-500/20 shrink-0 no-select">
                    {{ proj.licenseSpdx }}
                  </span>
                </div>
                <span class="text-xs text-[var(--color-text-subtle)] font-mono shrink-0 no-select">
                  ⭐ {{ proj.starCount }}
                </span>
              </div>

              <p class="text-xs text-[var(--color-text-muted)] line-clamp-2 mb-2 selectable">
                {{ proj.description || '暂无描述' }}
              </p>

              <div class="flex items-center justify-between text-[11px] text-[var(--color-text-subtle)] no-select">
                <span>{{ proj.primaryLanguage || '未标注' }}</span>
                <span>{{ proj.updatedAt ? `更新于 ${new Date(proj.updatedAt).toLocaleDateString()}` : '' }}</span>
              </div>
            </div>
          </div>

          <div v-if="userStore.repos.length === 0" class="py-12 text-center text-xs text-[var(--color-text-subtle)] no-select">
            {{ userStore.repoSync.status === 'loading' ? '正在拉取仓库列表...' : '暂无公开仓库' }}
          </div>
        </div>

        <!-- Guest state for projects -->
        <div v-else class="py-16 text-center space-y-3 no-select">
          <div class="w-12 h-12 mx-auto rounded-2xl card-raised border border-[var(--color-border)] flex items-center justify-center text-xl text-[var(--color-text-subtle)]">
            📦
          </div>
          <div class="text-sm font-bold text-[var(--color-text)]">展示您的公开开源项目</div>
          <p class="text-xs text-[var(--color-text-muted)] max-w-xs mx-auto">
            登录后，应用会自动将您的公开项目同步并缓存到本机。
          </p>
          <button
            @click="$emit('open-login')"
            class="px-4 py-2 rounded-xl btn-primary text-xs cursor-pointer"
          >
            登录同步公开项目
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useUserStore } from '../stores/user'
import { useHistoryStore } from '../stores/history'
import { openRepository } from '../services/projects'
import { formatHistoryTime } from '../utils/time'

const emit = defineEmits(['edit-profile', 'open-settings', 'open-login'])

const userStore = useUserStore()
const historyStore = useHistoryStore()

const activeTab = ref('history')
const historyKeyword = ref('')
const isRefreshing = ref(false)

const profile = computed(() => userStore.profile)
const interestTags = computed(() => userStore.interestTags)
const avatarUrl = computed(() => profile.value?.avatarUrl || 'https://avatars.githubusercontent.com/u/9919?s=200&v=4')

const starCountDisplay = computed(() => {
  if (userStore.starSync.complete) {
    return userStore.stars.length
  }
  return userStore.stars.length > 0 ? `${userStore.stars.length}+` : '-'
})

const tabs = computed(() => [
  { id: 'history', label: '浏览历史', count: historyStore.total },
  { id: 'stars', label: '我的 Star', count: userStore.stars.length },
  { id: 'projects', label: '我的项目', count: userStore.repos.length }
])

const openRepo = async (repo, source) => {
  await openRepository(repo, source, userStore.canRecordHistory)
}

const refreshData = async () => {
  if (isRefreshing.value) return
  isRefreshing.value = true
  try {
    await userStore.refreshAccountData()
  } finally {
    isRefreshing.value = false
  }
}

let searchTimer = null
const handleHistorySearch = () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    historyStore.loadFirstPage(historyKeyword.value.trim())
  }, 300)
}

const clearSearch = () => {
  historyKeyword.value = ''
  historyStore.loadFirstPage('')
}

const deleteHistoryItem = async (repoId) => {
  await historyStore.remove(repoId)
}

const confirmClearHistory = async () => {
  if (window.confirm('仅删除本机当前账号的浏览历史？')) {
    await historyStore.clearAll()
  }
}

const unstarRepo = async (repo) => {
  await userStore.setStar(repo, false)
}
</script>

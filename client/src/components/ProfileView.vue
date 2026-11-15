<template>
  <div class="profile-page flex-1 min-w-0 flex flex-col text-[var(--color-text)] safe-area-bottom">
    <div class="profile-cover relative border-b border-[var(--color-border)] no-select">
      <div class="relative z-10 flex flex-wrap items-center justify-between gap-3 mb-5">
        <div class="flex items-center gap-2 text-[13px]">
          <span
            aria-hidden="true"
            class="w-2 h-2 rounded-full shrink-0"
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
              userStore.hasAccount ? 'GitHub 已连接' : '游客模式（只读）'
            }}
          </span>
        </div>
        <div class="profile-actions flex items-center gap-2">
          <button
            v-if="userStore.hasAccount"
            type="button"
            @click="refreshData"
            :disabled="isRefreshing"
            :aria-busy="isRefreshing"
            aria-label="刷新个人数据"
            class="icon-button rounded-full bg-[var(--color-surface-raised)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition cursor-pointer"
            title="刷新个人数据"
          >
            <RefreshCw :class="['w-[18px] h-[18px]', isRefreshing ? 'animate-spin text-[var(--color-primary)]' : '']" aria-hidden="true" />
          </button>
          <button
            type="button"
            @click="$emit('open-settings')"
            aria-label="打开应用设置"
            class="icon-button rounded-full bg-[var(--color-surface-raised)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition cursor-pointer"
            title="应用设置"
          >
            <Settings class="w-[18px] h-[18px]" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        v-if="userStore.needsReauth"
        class="profile-notice relative z-10 mb-5 p-4 rounded-2xl bg-[var(--color-surface-raised)] border border-[var(--color-danger)] flex flex-wrap items-center justify-between gap-3 text-sm"
      >
        <div class="min-w-0 text-[var(--color-danger)]">
          <p class="font-semibold">授权已失效</p>
          <p class="text-[13px] mt-1 leading-relaxed">重新授权以同步最新公开仓库与 Star。</p>
        </div>
        <button type="button" @click="$emit('open-login')" class="px-4 py-2 rounded-xl btn-primary text-sm cursor-pointer shrink-0">重新授权</button>
      </div>
      <div
        v-else-if="!userStore.hasAccount"
        class="profile-notice relative z-10 mb-5 p-4 rounded-2xl bg-[var(--color-surface-raised)] border border-[var(--color-border)] flex flex-wrap items-center justify-between gap-3 text-sm"
      >
        <div class="min-w-0">
          <p class="font-semibold text-[var(--color-text)]">当前为游客模式</p>
          <p class="text-[13px] text-[var(--color-text-muted)] mt-1 leading-relaxed">登录后可同步公开项目、自定义技术兴趣并记录本机历史。</p>
        </div>
        <button type="button" @click="$emit('open-login')" class="px-4 py-2 rounded-xl btn-primary text-sm cursor-pointer shrink-0">登录账号</button>
      </div>

      <div class="relative z-10 flex items-start gap-4 mb-4">
        <img
          v-if="avatarUrl"
          :src="avatarUrl"
          :alt="`${profile?.login || '游客'}的头像`"
          class="w-16 h-16 rounded-full object-cover border border-[var(--color-border)] shrink-0"
        />
        <div v-else role="img" aria-label="默认头像" class="w-16 h-16 rounded-full border border-[var(--color-border)] bg-[var(--color-primary-subtle)] text-[var(--color-primary)] shrink-0 flex items-center justify-center">
          <UserRound :size="30" aria-hidden="true" />
        </div>
        <div class="flex-1 min-w-0">
          <h2 class="text-xl font-semibold text-[var(--color-text)] break-words [overflow-wrap:anywhere] selectable">
            {{ profile?.displayName || profile?.login || (userStore.hasAccount ? '已保存账号' : '游客用户') }}
          </h2>
          <p v-if="profile?.login" class="text-sm text-[var(--color-text-subtle)] mt-1 break-words [overflow-wrap:anywhere] selectable">@{{ profile.login }}</p>
          <div v-if="userStore.hasAccount" class="text-[13px] text-[var(--color-text-muted)] mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 selectable">
            <span v-if="profile?.location" class="inline-flex items-center gap-1.5 min-w-0 [overflow-wrap:anywhere]">
              <MapPin class="w-4 h-4 shrink-0" aria-hidden="true" />{{ profile.location }}
            </span>
            <span v-if="profile?.company" class="inline-flex items-center gap-1.5 min-w-0 [overflow-wrap:anywhere]">
              <Building2 class="w-4 h-4 shrink-0" aria-hidden="true" />{{ profile.company }}
            </span>
          </div>
        </div>
      </div>
      <p class="relative z-10 text-[15px] text-[var(--color-text-muted)] leading-relaxed mb-5 break-words [overflow-wrap:anywhere] selectable">
        {{ profile?.bio || (userStore.hasAccount ? '暂未填写个人简介' : '游客模式可浏览公开热门项目，登录后可开启个人历史与同步。') }}
      </p>

      <section class="relative z-10 mb-5" aria-labelledby="profile-interest-heading">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h3 id="profile-interest-heading" class="text-sm font-semibold text-[var(--color-text)]">技术兴趣</h3>
            <p class="text-[13px] text-[var(--color-text-subtle)] mt-1">根据公开仓库与 Star 归纳</p>
          </div>
          <button
            v-if="userStore.hasAccount"
            type="button"
            @click="$emit('edit-profile')"
            class="px-3 py-2 rounded-xl text-sm text-[var(--color-primary)] hover:underline cursor-pointer"
          >兴趣设置</button>
        </div>
        <div class="flex flex-wrap gap-2">
          <span v-for="tag in interestTags" :key="tag" class="px-2.5 py-1 rounded-lg text-[13px] card-raised border border-[var(--color-border)] text-[var(--color-text)] max-w-full [overflow-wrap:anywhere]"># {{ tag }}</span>
          <p v-if="interestTags.length === 0" class="text-[13px] text-[var(--color-text-subtle)] leading-relaxed">
            {{ userStore.hasAccount ? '暂未归纳出技术兴趣，可在“兴趣设置”中手动添加。' : '登录后将基于公开仓库与 Star 自动提取。' }}
          </p>
        </div>
      </section>

      <dl class="relative z-10 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-4 py-4 px-3 rounded-2xl card-raised border border-[var(--color-border)] text-center">
        <div class="flex flex-col-reverse gap-1">
          <dt class="text-[13px] text-[var(--color-text-muted)]">公开项目</dt>
          <dd class="text-lg font-semibold text-[var(--color-text)] tabular-nums">{{ userStore.hasAccount ? (profile?.publicRepoCount ?? userStore.repos.length) : '—' }}</dd>
        </div>
        <div class="flex flex-col-reverse gap-1">
          <dt class="text-[13px] text-[var(--color-text-muted)]">我的 Star</dt>
          <dd class="text-lg font-semibold text-[var(--color-text)] tabular-nums">{{ userStore.hasAccount ? starCountDisplay : '—' }}</dd>
        </div>
        <div class="flex flex-col-reverse gap-1">
          <dt class="text-[13px] text-[var(--color-text-muted)]">关注者</dt>
          <dd class="text-lg font-semibold text-[var(--color-text)] tabular-nums">{{ userStore.hasAccount ? (profile?.followerCount ?? 0) : '—' }}</dd>
        </div>
        <div class="flex flex-col-reverse gap-1">
          <dt class="text-[13px] text-[var(--color-text-muted)]">正在关注</dt>
          <dd class="text-lg font-semibold text-[var(--color-text)] tabular-nums">{{ userStore.hasAccount ? (profile?.followingCount ?? 0) : '—' }}</dd>
        </div>
      </dl>
    </div>

    <div role="group" aria-label="个人项目浏览方式" class="profile-tabs sticky top-0 z-20 bg-[var(--color-bg)]/95 backdrop-blur border-b border-[var(--color-border)] flex text-center no-select">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        :aria-pressed="activeTab === tab.id"
        aria-controls="profile-collection"
        @click="activeTab = tab.id"
        :class="[
          'flex-1 min-w-0 px-2 py-3 text-sm font-medium transition relative cursor-pointer',
          activeTab === tab.id ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-subtle)] hover:text-[var(--color-text-muted)]'
        ]"
      >
        <span>{{ tab.label }}</span>
        <span v-if="userStore.hasAccount && tab.count !== undefined" class="text-[13px] ml-1 text-[var(--color-text-muted)] tabular-nums">{{ tab.count }}</span>
        <span v-if="activeTab === tab.id" aria-hidden="true" class="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-[var(--color-primary)] rounded-full"></span>
      </button>
    </div>

    <section
      id="profile-collection"
      :aria-label="tabs.find(tab => tab.id === activeTab)?.label"
      :aria-busy="activeTab === 'history' ? historyStore.isLoading || historyStore.isLoadingMore : activeTab === 'stars' ? userStore.starPage.loading : userStore.repoPage.loading"
      class="profile-content flex-1 min-w-0 p-4"
    >
      <p v-if="feedback" role="status" class="text-sm text-[var(--color-text-muted)] mb-4 leading-relaxed">{{ feedback }}</p>
      <div v-if="activeTab === 'history'" class="space-y-4">
        <div v-if="userStore.hasAccount">
          <div class="flex flex-wrap items-center gap-2 mb-4 no-select">
            <div class="flex-1 min-w-[180px] relative">
              <label for="history-search" class="sr-only">搜索浏览历史</label>
              <input
                id="history-search"
                v-model="historyKeyword"
                @input="handleHistorySearch"
                type="search"
                placeholder="搜索仓库名称或简介"
                class="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl pl-3 pr-12 py-3 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-primary)] transition"
              />
              <button v-if="historyKeyword" type="button" @click="clearSearch" aria-label="清除历史搜索关键词" class="icon-button absolute right-0 top-1/2 -translate-y-1/2 text-[var(--color-text-subtle)] hover:text-[var(--color-text)] cursor-pointer">
                <X class="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
            <button v-if="historyStore.items.length > 0" type="button" @click="confirmClearHistory" class="px-3 py-2 text-sm text-[var(--color-danger)] rounded-xl transition cursor-pointer">清空历史</button>
          </div>
          <p v-if="historyStore.error" role="alert" class="text-sm text-[var(--color-danger)] mb-3">{{ historyStore.error }}</p>
          <div class="space-y-3">
            <article v-for="item in historyStore.items" :key="item.repoId" class="p-4 rounded-2xl card-surface hover:border-[var(--color-text-subtle)] transition flex flex-col min-w-0">
              <div class="project-card-header flex flex-wrap items-start justify-between gap-3 mb-2">
                <h3 class="min-w-0 flex-1 text-base font-semibold text-[var(--color-text)]">
                  <button type="button" @click="openRepo(item.repository || item, 'history')" :aria-label="`在 GitHub 打开 ${item.repository?.fullName || item.fullName || item.repository?.name || item.name}`" class="project-title text-left w-full min-w-0 break-words [overflow-wrap:anywhere] hover:text-[var(--color-primary)] transition cursor-pointer selectable">
                    {{ item.repository?.fullName || item.fullName || item.repository?.name || item.name }}
                  </button>
                </h3>
                <div class="flex flex-wrap items-center gap-2 text-[13px] text-[var(--color-text-subtle)] no-select">
                  <span>{{ formatHistoryTime(item.lastViewedAt) }}</span>
                  <button type="button" @click="deleteHistoryItem(item.repoId)" :aria-label="`删除 ${item.repository?.fullName || item.fullName || item.name} 的浏览记录`" class="icon-button text-[var(--color-text-subtle)] hover:text-[var(--color-danger)] transition cursor-pointer" title="删除此条浏览记录">
                    <Trash2 class="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <p class="text-[15px] leading-relaxed text-[var(--color-text-muted)] line-clamp-2 mb-3 break-words [overflow-wrap:anywhere] selectable">{{ item.repository?.description || '暂无描述' }}</p>
              <div class="flex flex-wrap items-center justify-between gap-2 text-[13px] text-[var(--color-text-subtle)] no-select">
                <div class="flex flex-wrap items-center gap-3">
                  <span v-if="item.repository?.primaryLanguage">{{ item.repository.primaryLanguage }}</span>
                  <span v-if="item.repository?.starCount" class="inline-flex items-center gap-1.5 tabular-nums"><Star class="w-3.5 h-3.5" aria-hidden="true" />{{ item.repository.starCount }}</span>
                </div>
                <span class="tabular-nums">访问 {{ item.visitCount }} 次</span>
              </div>
            </article>
          </div>
          <div v-if="historyStore.hasMore" class="pt-4 text-center no-select">
            <button type="button" @click="historyStore.loadMore" :disabled="historyStore.isLoadingMore" :aria-busy="historyStore.isLoadingMore" class="px-4 py-2 rounded-xl btn-secondary text-sm cursor-pointer">{{ historyStore.isLoadingMore ? '加载中…' : '加载更多历史' }}</button>
          </div>
          <p v-if="!historyStore.isLoading && historyStore.items.length === 0" role="status" class="py-12 text-center text-sm text-[var(--color-text-subtle)] no-select">{{ historyKeyword ? '未找到符合条件的浏览历史' : '暂无浏览记录，打开项目后可在这里继续查看。' }}</p>
        </div>
        <div v-else class="py-12 text-center space-y-4 no-select">
          <div class="w-14 h-14 mx-auto rounded-2xl card-raised border border-[var(--color-border)] flex items-center justify-center text-[var(--color-text-subtle)]"><ShieldCheck class="w-6 h-6" aria-hidden="true" /></div>
          <h3 class="text-base font-semibold text-[var(--color-text)]">游客模式不记录浏览历史</h3>
          <p class="text-[15px] leading-relaxed text-[var(--color-text-muted)] max-w-sm mx-auto">登录 GitHub 后，在应用内查看项目会自动记录浏览历史，并保存在当前设备。</p>
          <button type="button" @click="$emit('open-login')" class="px-4 py-2 rounded-xl btn-primary text-sm cursor-pointer">登录以开启历史</button>
        </div>
      </div>

      <div v-if="activeTab === 'stars'" class="space-y-4">
        <div v-if="userStore.hasAccount">
          <p class="text-[13px] text-[var(--color-text-subtle)] mb-4 no-select" role="status">{{ userStore.starSync.complete ? `已完整同步，共 ${userStore.starPage.total ?? userStore.starSync.loadedCount} 项` : `已加载 ${userStore.stars.length} 项，同步中` }}</p>
          <div class="space-y-3">
            <article v-for="repo in userStore.stars" :key="repo.repoId" class="p-4 rounded-2xl card-surface hover:border-[var(--color-text-subtle)] transition flex flex-col min-w-0">
              <div class="project-card-header flex flex-wrap items-start justify-between gap-3 mb-2">
                <h3 class="min-w-0 flex-1 text-base font-semibold text-[var(--color-text)]">
                  <button type="button" @click="openRepo(repo, 'star')" :aria-label="`在 GitHub 打开 ${repo.fullName || repo.name}`" class="project-title text-left w-full min-w-0 break-words [overflow-wrap:anywhere] hover:text-[var(--color-primary)] transition cursor-pointer selectable">{{ repo.fullName || repo.name }}</button>
                </h3>
                <div class="profile-actions flex flex-wrap items-center gap-3 no-select">
                  <span class="text-[var(--color-star)] text-[13px] tabular-nums inline-flex items-center gap-1.5"><Star class="w-4 h-4" aria-hidden="true" />{{ repo.starCount }}</span>
                  <button
                    type="button"
                    @click="unstarRepo(repo)"
                    :disabled="userStore.starPendingByRepo[repo.repoId || repo.canonicalKey]"
                    :aria-busy="!!userStore.starPendingByRepo[repo.repoId || repo.canonicalKey]"
                    :aria-pressed="true"
                    :aria-label="`取消 ${repo.fullName || repo.name} 的 Star`"
                    class="text-sm px-3 py-2 rounded-xl border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition cursor-pointer inline-flex items-center justify-center gap-2"
                  >
                    <LoaderCircle v-if="userStore.starPendingByRepo[repo.repoId || repo.canonicalKey]" class="w-4 h-4 animate-spin" aria-hidden="true" />
                    取消 Star
                  </button>
                </div>
              </div>
              <p class="text-[15px] leading-relaxed text-[var(--color-text-muted)] line-clamp-2 mb-3 break-words [overflow-wrap:anywhere] selectable">{{ repo.description || '暂无描述' }}</p>
              <div class="flex flex-wrap items-center justify-between gap-2 text-[13px] text-[var(--color-text-subtle)] no-select">
                <span>{{ repo.primaryLanguage || '未标注' }}</span>
                <span>{{ repo.updatedAt ? `更新于 ${new Date(repo.updatedAt).toLocaleDateString()}` : '' }}</span>
              </div>
            </article>
          </div>
          <button v-if="userStore.starPage.nextOffset !== null" type="button" @click="loadMore('stars')" :disabled="userStore.starPage.loading" :aria-busy="userStore.starPage.loading" class="w-full btn-secondary text-sm mt-4">{{ userStore.starPage.loading ? '加载中…' : '加载更多 Star' }}</button>
          <p v-if="userStore.stars.length === 0" role="status" class="py-12 text-center text-sm text-[var(--color-text-subtle)] no-select">{{ userStore.starSync.status === 'loading' ? '正在拉取 Star 列表…' : '暂无公开 Star 仓库' }}</p>
        </div>
        <div v-else class="py-12 text-center space-y-4 no-select">
          <div class="w-14 h-14 mx-auto rounded-2xl card-raised border border-[var(--color-border)] flex items-center justify-center text-[var(--color-star)]"><Star class="w-6 h-6" aria-hidden="true" /></div>
          <h3 class="text-base font-semibold text-[var(--color-text)]">登录同步 GitHub Star</h3>
          <p class="text-[15px] leading-relaxed text-[var(--color-text-muted)] max-w-sm mx-auto">登录后即可查看与管理你在 GitHub 上 Star 过的公开项目。</p>
          <button type="button" @click="$emit('open-login')" class="px-4 py-2 rounded-xl btn-primary text-sm cursor-pointer">登录同步 Star</button>
        </div>
      </div>

      <div v-if="activeTab === 'projects'" class="space-y-4">
        <div v-if="userStore.hasAccount">
          <div class="space-y-3">
            <article v-for="proj in userStore.repos" :key="proj.repoId" class="p-4 rounded-2xl card-surface hover:border-[var(--color-text-subtle)] transition flex flex-col min-w-0">
              <div class="project-card-header flex flex-wrap items-start justify-between gap-3 mb-2">
                <div class="flex flex-wrap items-center gap-2 min-w-0 flex-1">
                  <h3 class="min-w-0 w-full text-base font-semibold text-[var(--color-text)]">
                    <button type="button" @click="openRepo(proj, 'projects')" :aria-label="`在 GitHub 打开 ${proj.fullName || proj.name}`" class="project-title text-left w-full min-w-0 break-words [overflow-wrap:anywhere] hover:text-[var(--color-primary)] transition cursor-pointer selectable">{{ proj.name }}</button>
                  </h3>
                  <span v-if="proj.isFork" class="px-2 py-1 rounded-md text-[13px] bg-[var(--color-surface-raised)] border border-[var(--color-border)] text-[var(--color-text-subtle)] no-select">Fork</span>
                  <span v-if="proj.licenseSpdx" class="px-2 py-1 rounded-md text-[13px] bg-emerald-500/10 text-[var(--color-success)] border border-emerald-500/20 max-w-full [overflow-wrap:anywhere] no-select">{{ proj.licenseSpdx }}</span>
                </div>
                <span class="text-[13px] text-[var(--color-text-subtle)] tabular-nums inline-flex items-center gap-1.5 shrink-0 no-select"><Star class="w-4 h-4" aria-hidden="true" />{{ proj.starCount }}</span>
              </div>
              <p class="text-[15px] leading-relaxed text-[var(--color-text-muted)] line-clamp-2 mb-3 break-words [overflow-wrap:anywhere] selectable">{{ proj.description || '暂无描述' }}</p>
              <div class="flex flex-wrap items-center justify-between gap-2 text-[13px] text-[var(--color-text-subtle)] no-select">
                <span>{{ proj.primaryLanguage || '未标注' }}</span>
                <span>{{ proj.updatedAt ? `更新于 ${new Date(proj.updatedAt).toLocaleDateString()}` : '' }}</span>
              </div>
            </article>
          </div>
          <button v-if="userStore.repoPage.nextOffset !== null" type="button" @click="loadMore('repos')" :disabled="userStore.repoPage.loading" :aria-busy="userStore.repoPage.loading" class="w-full btn-secondary text-sm mt-4">{{ userStore.repoPage.loading ? '加载中…' : '加载更多项目' }}</button>
          <p v-if="userStore.repos.length === 0" role="status" class="py-12 text-center text-sm text-[var(--color-text-subtle)] no-select">{{ userStore.repoSync.status === 'loading' ? '正在拉取仓库列表…' : '暂无公开仓库' }}</p>
        </div>
        <div v-else class="py-12 text-center space-y-4 no-select">
          <div class="w-14 h-14 mx-auto rounded-2xl card-raised border border-[var(--color-border)] flex items-center justify-center text-[var(--color-text-subtle)]"><FolderGit2 class="w-6 h-6" aria-hidden="true" /></div>
          <h3 class="text-base font-semibold text-[var(--color-text)]">展示你的公开开源项目</h3>
          <p class="text-[15px] leading-relaxed text-[var(--color-text-muted)] max-w-sm mx-auto">登录后会自动同步公开项目，方便在当前设备继续查看。</p>
          <button type="button" @click="$emit('open-login')" class="px-4 py-2 rounded-xl btn-primary text-sm cursor-pointer">登录同步公开项目</button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue'
import { Building2, FolderGit2, LoaderCircle, MapPin, RefreshCw, Settings, ShieldCheck, Star, Trash2, UserRound, X } from 'lucide-vue-next'
import { useUserStore } from '../stores/user'
import { useHistoryStore } from '../stores/history'
import { openRepository } from '../services/projects'
import { formatHistoryTime } from '../utils/time'

const emit = defineEmits(['edit-profile', 'open-settings', 'open-login'])

const userStore = useUserStore()
const historyStore = useHistoryStore()

const feedback = ref('')
const loadMore = async kind => { try { await userStore.loadCollection(kind, true) } catch (error) { feedback.value = error.message } }
const activeTab = ref('history')
const historyKeyword = ref('')
const isRefreshing = ref(false)

const profile = computed(() => userStore.profile)
const interestTags = computed(() => userStore.interestTags)
const avatarUrl = computed(() => profile.value?.avatarUrl || '')

const starCountDisplay = computed(() => {
  if (userStore.starSync.complete) {
    return userStore.starPage.total ?? userStore.starSync.loadedCount
  }
  return userStore.stars.length > 0 ? `${userStore.stars.length}+` : '-'
})

const tabs = computed(() => [
  { id: 'history', label: '浏览历史', count: historyStore.total },
  { id: 'stars', label: '我的 Star', count: userStore.starPage.total ?? userStore.starSync.loadedCount },
  { id: 'projects', label: '我的项目', count: userStore.repoPage.total ?? userStore.repoSync.loadedCount }
])

const openRepo = async (repo, source) => {
  const result = await openRepository(repo, source, userStore.canRecordHistory)
  if (!result.opened) feedback.value = '无法打开仓库链接'
  else if (userStore.canRecordHistory && !result.historySaved) feedback.value = '仓库已打开，浏览历史保存失败'
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
onUnmounted(() => clearTimeout(searchTimer))
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
  const result = await userStore.setStar(repo, false)
  feedback.value = result.success ? result.warning || '已取消 Star' : result.error
}
</script>

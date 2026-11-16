<template>
  <div class="profile-page flex-1 flex flex-col text-[var(--color-text)] safe-area-bottom">
    <!-- Top Cover & Header -->
    <div class="profile-cover relative border-b border-[var(--color-border)] no-select">
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
            v-if="userStore.hasAccount"
            @click="refreshData"
            :disabled="isRefreshing"
            class="p-2 rounded-full bg-[var(--color-surface-raised)] border border-[var(--color-border)] hover:border-[var(--color-text-muted)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition cursor-pointer"
            title="刷新个人数据"
          >
            <svg :class="['w-4 h-4', isRefreshing ? 'animate-spin text-[var(--color-primary)]' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            @click="$emit('open-settings')"
            class="p-2 rounded-full bg-[var(--color-surface-raised)] border border-[var(--color-border)] hover:border-[var(--color-text-muted)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition cursor-pointer"
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
        class="relative z-10 mb-4 p-3 rounded-2xl bg-red-50 border border-[var(--color-danger)] flex items-center justify-between gap-3 text-xs"
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

      <!-- Technical Interest Tags (本机手选标签与云端画像摘要) -->
      <div class="relative z-10 mb-4 space-y-3">
        <div>
          <div class="flex items-center justify-between text-[11px] text-[var(--color-text-muted)] font-semibold mb-2">
            <span>本机兴趣标签 (手动设置)</span>
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
              {{ userStore.hasAccount ? '暂未添加手动标签，可点击“兴趣设置”补充' : '登录后可自定义兴趣标签' }}
            </span>
          </div>
        </div>

        <!-- 云端技术画像摘要卡 -->
        <div v-if="userStore.hasAccount" class="p-3.5 rounded-2xl card-raised border border-[var(--color-border)] space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div class="flex items-center gap-2">
              <span class="font-semibold text-[var(--color-text)]">云端技术兴趣画像</span>
              <span
                class="px-2 py-0.5 rounded-full text-[10px] font-medium border"
                :class="portraitBadgeClass"
              >
                {{ portraitStatusLabel }}
              </span>
            </div>
            <button
              @click="refreshPortrait"
              :disabled="userStore.cloudPortraitLoading"
              class="text-[11px] text-[var(--color-primary)] hover:underline cursor-pointer"
            >
              {{ userStore.cloudPortraitLoading ? '刷新中...' : '刷新云端画像' }}
            </button>
          </div>

          <div class="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
            {{ portraitSummaryText }}
          </div>

          <div v-if="cloudDirections.length > 0" class="flex flex-wrap gap-1.5 pt-1">
            <span
              v-for="dir in cloudDirections.slice(0, 4)"
              :key="dir.directionId || dir.label"
              class="px-2 py-0.5 rounded-lg text-[11px] bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text)]"
            >
              {{ dir.label || dir.directionId }}
              <span v-if="dir.weight !== undefined" class="font-mono text-[var(--color-primary)] ml-1">{{ Math.round(dir.weight * 100) }}%</span>
            </span>
          </div>

          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[var(--color-text-subtle)] font-mono pt-1">
            <span>模型: {{ cloudPortrait?.modelVersion || '待生成' }}</span>
            <span v-if="cloudPortrait?.generatedAt">更新: {{ formatHistoryTime(cloudPortrait.generatedAt) }}</span>
            <span>处理进度: {{ cloudPortrait?.processedThrough ?? userStore.cloudSync.processedThrough ?? 0 }} / {{ userStore.cloudSync.acceptedThrough ?? 0 }}</span>
            <span v-if="(cloudPortrait?.unprocessedCount || 0) > 0">
              本机待合并: {{ cloudPortrait.unprocessedCount }} 次浏览
            </span>
          </div>
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
              <span v-if="historyKeyword" @click="clearSearch" class="absolute right-2.5 top-2 text-xs text-[var(--color-text-subtle)] hover:text-[var(--color-text)] cursor-pointer">✕</span>
            </div>
            <button
              v-if="historyStore.items.length > 0"
              @click="confirmClearHistory"
              class="px-2.5 py-2 text-xs text-[var(--color-danger)] hover:bg-red-50 rounded-xl transition cursor-pointer"
            >
              清空
            </button>
          </div>

          <p v-if="historyStore.error" class="text-xs text-[var(--color-danger)]">{{ historyStore.error }}</p>
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
                  {{ item.repository?.fullName }}
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
                {{ item.repository?.description || '暂无描述' }}
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

      <p v-if="feedback" role="status" class="text-xs text-[var(--color-text-muted)] mb-3">{{ feedback }}</p>
      <!-- 2. 我的 Star -->
      <div v-if="activeTab === 'stars'" class="space-y-3">
        <div v-if="userStore.hasAccount">
          <!-- 同步状态提示 -->
          <div class="flex items-center justify-between text-xs text-[var(--color-text-subtle)] pb-1 no-select">
            <span>
              {{ userStore.starSync.complete ? `已完整同步 (共 ${userStore.starPage.total ?? userStore.starSync.loadedCount} 项)` : `已加载 ${userStore.stars.length} 项 (同步中)` }}
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

          <button v-if="userStore.starPage.nextOffset !== null" @click="loadMore('stars')" :disabled="userStore.starPage.loading" class="w-full btn-secondary text-xs mt-3">
            {{ userStore.starPage.loading ? '加载中...' : '加载更多' }}
          </button>
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
                    @click="openRepo(proj, 'projects')"
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

          <button v-if="userStore.repoPage.nextOffset !== null" @click="loadMore('repos')" :disabled="userStore.repoPage.loading" class="w-full btn-secondary text-xs mt-3">
            {{ userStore.repoPage.loading ? '加载中...' : '加载更多' }}
          </button>
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

      <!-- 4. 个人学习画像明细与证据引用 -->
      <div v-if="activeTab === 'portrait'" class="space-y-4">
        <div v-if="userStore.hasAccount">
          <div class="flex items-center justify-between mb-3">
            <div class="text-xs text-[var(--color-text-muted)]">
              状态：<strong class="text-[var(--color-text)]">{{ portraitStatusLabel }}</strong>
              <span v-if="cloudPortrait?.generationId" class="ml-2 font-mono text-[10px]">Generation: {{ cloudPortrait.generationId }}</span>
            </div>
            <button
              @click="refreshPortrait"
              :disabled="userStore.cloudPortraitLoading"
              class="px-3 py-1.5 rounded-xl btn-secondary text-xs !min-h-0 cursor-pointer"
            >
              {{ userStore.cloudPortraitLoading ? '正在同步...' : '同步最新画像' }}
            </button>
          </div>

          <div v-if="portraitDetail" class="space-y-4">
            <!-- 学习到的方向权重 -->
            <div class="p-4 rounded-2xl card-surface space-y-3">
              <div class="text-xs font-bold text-[var(--color-text)]">学习到的技术兴趣方向</div>
              <div v-if="cloudDirections.length > 0" class="space-y-2.5">
                <div v-for="dir in cloudDirections" :key="dir.directionId || dir.label" class="space-y-1">
                  <div class="flex items-center justify-between text-xs">
                    <span class="font-medium text-[var(--color-text)]">{{ dir.label || dir.directionId }}</span>
                    <span class="font-mono text-[var(--color-primary)]">{{ Math.round((dir.weight || 0) * 100) }}%</span>
                  </div>
                  <div class="w-full h-1.5 rounded-full bg-[var(--color-surface-raised)] overflow-hidden">
                    <div class="h-full bg-[var(--color-primary)] rounded-full" :style="{ width: `${Math.min(100, Math.round((dir.weight || 0) * 100))}%` }"></div>
                  </div>
                  <div v-if="dir.topics && dir.topics.length > 0" class="flex flex-wrap gap-1 pt-0.5">
                    <span v-for="t in dir.topics.slice(0, 5)" :key="t" class="px-1.5 py-0.5 rounded text-[10px] bg-[var(--color-surface-raised)] text-[var(--color-text-subtle)]">#{{ t }}</span>
                  </div>
                </div>
              </div>
              <div v-else class="text-xs text-[var(--color-text-subtle)]">
                暂无学习型方向分布，当前仅展示个人基础语言与主题统计。
              </div>
            </div>

            <!-- 语言与主题权重 -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div class="p-4 rounded-2xl card-surface space-y-2">
                <div class="text-xs font-bold text-[var(--color-text)]">主要编程生态分布</div>
                <div v-for="[lang, w] in topLanguages" :key="lang" class="flex items-center justify-between text-xs">
                  <span class="text-[var(--color-text-muted)]">{{ lang }}</span>
                  <span class="font-mono text-[var(--color-text)]">{{ Math.round(w * 100) }}%</span>
                </div>
                <div v-if="topLanguages.length === 0" class="text-[11px] text-[var(--color-text-subtle)]">暂无语言分布</div>
              </div>

              <div class="p-4 rounded-2xl card-surface space-y-2">
                <div class="text-xs font-bold text-[var(--color-text)]">Top 兴趣标签</div>
                <div v-for="ti in (portraitDetail.topInterests || []).slice(0, 8)" :key="ti.tag" class="flex items-center justify-between text-xs">
                  <span class="text-[var(--color-text-muted)]">#{{ ti.tag }}</span>
                  <span class="font-mono text-[var(--color-text)]">{{ Math.round((ti.score || 0) * 100) }}%</span>
                </div>
                <div v-if="!(portraitDetail.topInterests || []).length" class="text-[11px] text-[var(--color-text-subtle)]">暂无主题分布</div>
              </div>
            </div>

            <!-- 可追溯证据项目 (严格源自个人可用输入) -->
            <div class="p-4 rounded-2xl card-surface space-y-2.5">
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-[var(--color-text)]">个人证据引用项目</span>
                <span class="text-[10px] text-[var(--color-text-subtle)]">均来自本人公开项目、Star 或有效浏览</span>
              </div>
              <div v-if="portraitEvidenceRepos.length > 0" class="space-y-2">
                <div
                  v-for="ev in portraitEvidenceRepos"
                  :key="ev.repoId || ev.fullName"
                  class="p-2.5 rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)] flex items-center justify-between gap-2 text-xs"
                >
                  <div class="min-w-0">
                    <span
                      @click="ev.htmlUrl && openRepo(ev, 'portrait_evidence')"
                      class="font-medium text-[var(--color-text)] hover:text-[var(--color-primary)] cursor-pointer truncate block"
                    >
                      {{ ev.fullName || `项目 ID: ${ev.repoId}` }}
                    </span>
                    <span v-if="ev.sources && ev.sources.length > 0" class="text-[10px] text-[var(--color-text-subtle)]">
                      依据来源: {{ ev.sources.join(' / ') }}
                    </span>
                  </div>
                  <span v-if="ev.primaryLanguage" class="text-[10px] text-[var(--color-text-muted)] shrink-0">{{ ev.primaryLanguage }}</span>
                </div>
              </div>
              <div v-else class="text-xs text-[var(--color-text-subtle)]">
                暂无引用项目明细。
              </div>
            </div>
          </div>

          <div v-else class="py-12 text-center space-y-2 card-surface p-6">
            <div class="text-sm font-bold text-[var(--color-text)]">{{ portraitStatusLabel }}</div>
            <p class="text-xs text-[var(--color-text-muted)] max-w-md mx-auto leading-relaxed">
              {{ portraitSummaryText }}
            </p>
          </div>
        </div>
        <div v-else class="py-16 text-center text-xs text-[var(--color-text-subtle)]">
          连接 GitHub 并开启云端分析后，可在此查看离线训练与个人画像进展。
        </div>
      </div>

      <!-- 5. 群体聚合技术分布 (绝不用个人标签冒充群体分析) -->
      <div v-if="activeTab === 'cohorts'" class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2 pb-1">
          <div class="text-xs text-[var(--color-text-muted)]">
            <span v-if="userStore.cloudCohorts">
              模型 {{ userStore.cloudCohorts.modelVersion || '未标注' }} · 来源: {{ formatCohortSource(userStore.cloudCohorts.sourceKind) }}
              <span v-if="userStore.cloudCohorts.generatedAt"> · 生成于 {{ formatHistoryTime(userStore.cloudCohorts.generatedAt) }}</span>
            </span>
            <span v-else>展示群体聚合技术分布与样本量（仅聚合统计，不含未授权个人标签）</span>
          </div>
          <button
            @click="refreshCohorts"
            :disabled="userStore.cloudCohortsLoading"
            class="px-3 py-1.5 rounded-xl btn-secondary text-xs !min-h-0 cursor-pointer"
          >
            {{ userStore.cloudCohortsLoading ? '刷新中...' : '刷新群体分布' }}
          </button>
        </div>

        <div v-if="cohortList.length > 0" class="space-y-3">
          <div
            v-for="cohort in cohortList"
            :key="cohort.cohortId"
            class="p-4 rounded-2xl card-surface space-y-2.5"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="text-sm font-bold text-[var(--color-text)]">{{ cohort.label || cohort.cohortId }}</div>
              <span class="px-2 py-0.5 rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] text-[11px] font-mono text-[var(--color-text-muted)]">
                样本数: {{ cohort.memberCount }}
              </span>
            </div>

            <div v-if="cohort.suppressed" class="text-xs text-[var(--color-text-subtle)] italic">
              该分组当前真实样本少于 10 名，为保护隐私已抑制细分技术分布展示。
            </div>
            <div v-else class="space-y-2">
              <div class="flex flex-wrap gap-1.5">
                <span
                  v-for="[lang, val] in topEntries(cohort.languages, 4)"
                  :key="lang"
                  class="px-2 py-0.5 rounded-md text-[10px] bg-blue-500/10 text-[var(--color-primary)] border border-blue-500/20 font-mono"
                >
                  {{ lang }} {{ Math.round(val * 100) }}%
                </span>
                <span
                  v-for="[topic, val] in topEntries(cohort.topics, 5)"
                  :key="topic"
                  class="px-2 py-0.5 rounded-md text-[10px] bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] border border-[var(--color-border)]"
                >
                  #{{ topic }} ({{ Math.round(val * 100) }}%)
                </span>
              </div>
              <div v-if="(cohort.representativeRepositories || []).length > 0" class="text-[11px] text-[var(--color-text-subtle)]">
                群体代表项目:
                <span class="font-mono text-[var(--color-text-muted)]">
                  {{ cohort.representativeRepositories.slice(0, 3).map(r => r.fullName || r.repoId).join(', ') }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div v-else class="py-12 text-center text-xs text-[var(--color-text-subtle)] card-surface">
          暂无服务端群体分布缓存，请点击右上角“刷新群体分布”拉取已发布的群体聚合统计。
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue'
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
const avatarUrl = computed(() => profile.value?.avatarUrl || 'https://avatars.githubusercontent.com/u/9919?s=200&v=4')

const cloudPortrait = computed(() => userStore.cloudPortrait)
const portraitDetail = computed(() => cloudPortrait.value?.portrait || null)
const cloudDirections = computed(() => {
  const dirs = portraitDetail.value?.directions || []
  return Array.isArray(dirs) ? dirs : []
})
const portraitEvidenceRepos = computed(() => {
  const ev = portraitDetail.value?.evidenceRepos || []
  return Array.isArray(ev) ? ev : []
})
const topLanguages = computed(() => topEntries(portraitDetail.value?.languages, 5))
const cohortList = computed(() => {
  const list = userStore.cloudCohorts?.cohorts || []
  return Array.isArray(list) ? list : []
})

function topEntries(obj, limit = 5) {
  if (!obj || typeof obj !== 'object') return []
  return Object.entries(obj)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, limit)
}

const portraitStatusLabel = computed(() => {
  const status = cloudPortrait.value?.status || (userStore.preferences?.analysisEnabled === false ? 'analysis_disabled' : 'unbound')
  const map = {
    ready: '当前已发布',
    pending: '处理中 / 待推断',
    stale: '旧代结果 (有新行为待处理)',
    empty: '暂无足够个人证据',
    analysis_disabled: '已关闭云端分析',
    unbound: '未绑定云端会话'
  }
  return map[status] || status
})

const portraitBadgeClass = computed(() => {
  const status = cloudPortrait.value?.status || 'unbound'
  if (status === 'ready') return 'bg-emerald-500/10 text-[var(--color-success)] border-emerald-500/20'
  if (status === 'pending' || status === 'stale') return 'bg-amber-500/10 text-[var(--color-star)] border-amber-500/20'
  return 'bg-[var(--color-surface)] text-[var(--color-text-subtle)] border-[var(--color-border)]'
})

const portraitSummaryText = computed(() => {
  const status = cloudPortrait.value?.status || (userStore.preferences?.analysisEnabled === false ? 'analysis_disabled' : 'unbound')
  if (status === 'analysis_disabled') {
    return '您已在设置中关闭云端分析，已停止上传后续行为并清除云端分析依赖。'
  }
  if (status === 'unbound') {
    return '尚未在设置中绑定云端分析会话，当前发现页使用本机公开信息基线与手动标签排序。'
  }
  if (status === 'empty') {
    return '当前账号暂无足够公开仓库、Star 或有效浏览证据，系统保持空画像，不会强行猜测兴趣方向。'
  }
  if (status === 'pending') {
    return '服务端已接收上传的行为与集合，正在排队进行离线画像推断，结果发布前本地近期浏览会作为补充增量。'
  }
  if (status === 'stale') {
    return `当前展示的是 ${cloudPortrait.value?.generatedAt ? formatHistoryTime(cloudPortrait.value.generatedAt) : '上一批次'} 的历史结果；新增行为尚未被该代处理进度完全覆盖。`
  }
  return `已使用模型 ${cloudPortrait.value?.modelVersion || ''} 完成个人兴趣方向推断，所有证据项目均来自当前账号可用输入。`
})

function formatCohortSource(sourceKind) {
  if (sourceKind === 'synthetic') return '合成基准样本'
  if (sourceKind === 'mixed') return '混合样本'
  return '真实生产观测'
}

const refreshPortrait = async () => {
  await userStore.refreshCloudPortraitData()
}

const refreshCohorts = async () => {
  await userStore.refreshCloudCohortsData()
}

const starCountDisplay = computed(() => {
  if (userStore.starSync.complete) {
    return userStore.starPage.total ?? userStore.starSync.loadedCount
  }
  return userStore.stars.length > 0 ? `${userStore.stars.length}+` : '-'
})

const tabs = computed(() => [
  { id: 'history', label: '浏览历史', count: historyStore.total },
  { id: 'stars', label: '我的 Star', count: userStore.starPage.total ?? userStore.starSync.loadedCount },
  { id: 'projects', label: '我的项目', count: userStore.repoPage.total ?? userStore.repoSync.loadedCount },
  { id: 'portrait', label: '技术画像' },
  { id: 'cohorts', label: '群体分布' }
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

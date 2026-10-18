<template>
  <div class="flex-1 flex flex-col h-full bg-zinc-950 text-white overflow-y-auto">
    <!-- Douyin/TikTok Style Top Cover & Header -->
    <div class="relative bg-gradient-to-b from-zinc-900 to-zinc-950 pt-6 px-4 pb-4 border-b border-zinc-800/80">
      <!-- Background Ambient Glow -->
      <div class="absolute top-0 left-0 right-0 h-36 bg-gradient-to-r from-rose-600/20 via-purple-600/20 to-amber-600/20 pointer-events-none"></div>

      <!-- Top Utility Bar (Settings & Sync) -->
      <div class="relative z-10 flex items-center justify-between mb-4">
        <div class="flex items-center gap-1.5 text-xs text-zinc-400">
          <span
            :class="['w-2 h-2 rounded-full', userStore.isLoggedIn ? 'bg-emerald-400' : 'bg-amber-400']"
          ></span>
          <span>{{ userStore.isLoggedIn ? 'GitHub 已登录' : '游客模式 (只读)' }}</span>
        </div>
        <div class="flex items-center gap-2">
          <button
            v-if="!userStore.isLoggedIn"
            @click="$emit('open-login')"
            class="px-2.5 py-1 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30 text-xs font-medium hover:bg-rose-500/30 transition flex items-center gap-1"
          >
            <span>登录</span>
          </button>
          <button
            @click="$emit('open-settings')"
            class="p-2 rounded-full bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white transition backdrop-blur"
            title="系统设置"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Guest Warning Banner if in Guest Mode -->
      <div
        v-if="!userStore.isLoggedIn"
        class="relative z-10 mb-4 p-3 rounded-2xl bg-amber-500/10 border border-amber-500/25 flex items-center justify-between gap-3 text-xs"
      >
        <div class="flex items-center gap-2 text-amber-300">
          <span class="text-base">👤</span>
          <div>
            <div class="font-bold">当前为游客模式</div>
            <div class="text-[11px] text-amber-400/80">未记录个人隐私、浏览历史与用户画像</div>
          </div>
        </div>
        <button
          @click="$emit('open-login')"
          class="px-3 py-1.5 rounded-xl bg-amber-500 text-zinc-950 font-bold text-xs hover:bg-amber-400 active:scale-95 transition shrink-0"
        >
          立即登录
        </button>
      </div>

      <!-- Avatar & Basic Info -->
      <div class="relative z-10 flex items-start gap-4 mb-4">
        <div class="relative group">
          <img
            :src="user.avatar_url || 'https://avatars.githubusercontent.com/u/9919?s=200&v=4'"
            alt="User Avatar"
            class="w-20 h-20 rounded-full object-cover border-2 border-rose-500/80 shadow-xl shadow-rose-500/20"
          />
          <span class="absolute bottom-0 right-0 w-5 h-5 bg-zinc-900 border border-zinc-700 rounded-full flex items-center justify-center text-[10px]">
            {{ userStore.isLoggedIn ? '⚡' : '🔒' }}
          </span>
        </div>

        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <h2 class="text-xl font-bold text-white truncate">{{ user.name || (userStore.isLoggedIn ? user.username : '游客') }}</h2>
            <span
              :class="[
                'px-2 py-0.5 rounded-full text-[10px] font-medium border',
                userStore.isLoggedIn ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' : 'bg-zinc-800 text-zinc-400 border-zinc-700'
              ]"
            >
              {{ userStore.isLoggedIn ? 'Pro Dev' : '游客模式' }}
            </span>
          </div>
          <div class="text-xs text-zinc-400 font-mono mt-0.5">
            {{ userStore.isLoggedIn ? `@${user.username}` : '@GuestUser' }}
          </div>
          <div class="text-xs text-zinc-400 mt-2 flex items-center gap-3">
            <span>📍 {{ user.location || '未知' }}</span>
            <span>🏢 {{ user.company || 'Open Source' }}</span>
          </div>
        </div>
      </div>

      <!-- Bio / Profile Statement -->
      <p class="relative z-10 text-xs text-zinc-300 leading-relaxed mb-4">
        {{ user.bio || '还没有填写个人简介' }}
      </p>

      <!-- Multi-dimensional Tech Profiling Tags (多维用户画像) -->
      <div class="relative z-10 mb-4">
        <div class="flex items-center gap-1.5 text-[11px] text-zinc-400 font-semibold mb-2">
          <span class="text-amber-400">📊</span> 多维技术画像 (Hadoop MapReduce 提取)
        </div>
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="tag in user.tags"
            :key="tag"
            class="px-2.5 py-1 rounded-lg text-xs bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700/60 text-zinc-200 transition"
          >
            # {{ tag }}
          </span>
          <span
            v-if="!userStore.isLoggedIn"
            class="text-[11px] text-zinc-500 italic py-1"
          >
            (登录后自动基于开源仓库生成)
          </span>
        </div>
      </div>

      <!-- Stats Bar (Douyin Style) -->
      <div class="relative z-10 grid grid-cols-4 gap-2 py-3 px-2 rounded-2xl bg-zinc-900/80 border border-zinc-800/80 text-center mb-4">
        <div>
          <div class="text-base font-bold text-white">{{ userStore.isLoggedIn ? user.public_repos : '-' }}</div>
          <div class="text-[11px] text-zinc-400">公开项目</div>
        </div>
        <div>
          <div class="text-base font-bold text-white">{{ userStore.isLoggedIn ? userStore.myStars.length : '-' }}</div>
          <div class="text-[11px] text-zinc-400">我的 Star</div>
        </div>
        <div>
          <div class="text-base font-bold text-white">{{ userStore.isLoggedIn ? user.followers : '-' }}</div>
          <div class="text-[11px] text-zinc-400">关注者</div>
        </div>
        <div>
          <div class="text-base font-bold text-white">{{ userStore.isLoggedIn ? user.following : '-' }}</div>
          <div class="text-[11px] text-zinc-400">正在关注</div>
        </div>
      </div>

      <!-- Quick Action Buttons -->
      <div class="relative z-10 flex gap-2">
        <button
          v-if="userStore.isLoggedIn"
          @click="$emit('edit-profile')"
          class="flex-1 py-2 px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-white border border-zinc-700/60 transition flex items-center justify-center gap-1.5 active:scale-98"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
          编辑账号信息
        </button>
        <button
          v-else
          @click="$emit('open-login')"
          class="flex-1 py-2 px-3 rounded-xl bg-gradient-to-r from-rose-500 to-amber-500 hover:opacity-90 text-xs font-semibold text-white transition flex items-center justify-center gap-1.5 shadow-lg shadow-rose-500/20 active:scale-98"
        >
          <span>🔑 登录同步 GitHub 项目</span>
        </button>
        <button
          @click="$emit('open-settings')"
          class="py-2 px-4 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-300 border border-zinc-700/60 transition flex items-center justify-center gap-1.5"
        >
          系统设置
        </button>
      </div>
    </div>

    <!-- Douyin Style Sub-Tab Bar -->
    <div class="sticky top-0 z-20 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 flex text-center">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        @click="activeTab = tab.id"
        :class="[
          'flex-1 py-3 text-xs font-bold transition relative',
          activeTab === tab.id ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'
        ]"
      >
        <span>{{ tab.label }}</span>
        <span v-if="userStore.isLoggedIn && tab.count !== undefined" class="text-[10px] ml-1 opacity-70">({{ tab.count }})</span>
        <div
          v-if="activeTab === tab.id"
          class="absolute bottom-0 left-1/2 -translate-x-1/2 w-6 h-0.5 bg-gradient-to-r from-rose-500 to-amber-500 rounded-full"
        ></div>
      </button>
    </div>

    <!-- Tab Content -->
    <div class="flex-1 p-4">
      <!-- 1. 浏览历史 -->
      <div v-if="activeTab === 'history'" class="space-y-3">
        <div v-if="userStore.isLoggedIn">
          <div class="flex items-center justify-between pb-2">
            <span class="text-xs text-zinc-400">浏览记录用于 MapReduce 实时反馈优化</span>
            <button
              v-if="userStore.browseHistory.length > 0"
              @click="userStore.clearHistory"
              class="text-[11px] text-zinc-500 hover:text-rose-400 transition"
            >
              清空历史
            </button>
          </div>

          <div
            v-for="item in userStore.browseHistory"
            :key="item.id"
            class="p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 transition"
          >
            <div class="flex items-start justify-between gap-2 mb-1.5">
              <h4 class="text-sm font-bold text-white hover:text-rose-400 cursor-pointer flex items-center gap-1.5">
                <span>{{ item.name }}</span>
              </h4>
              <span class="text-[10px] text-zinc-500 whitespace-nowrap">{{ item.viewedAt }}</span>
            </div>
            <p class="text-xs text-zinc-400 line-clamp-2 mb-2">{{ item.desc }}</p>
            <div class="flex items-center justify-between text-[11px] text-zinc-400">
              <div class="flex items-center gap-3">
                <span class="flex items-center gap-1">
                  <span class="w-2 h-2 rounded-full bg-amber-400"></span>
                  {{ item.language }}
                </span>
                <span class="flex items-center gap-1">
                  ⭐ {{ item.stars.toLocaleString() }}
                </span>
              </div>
              <div class="flex gap-1">
                <span
                  v-for="tag in item.tags"
                  :key="tag"
                  class="px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] text-zinc-400"
                >
                  {{ tag }}
                </span>
              </div>
            </div>
          </div>

          <div v-if="userStore.browseHistory.length === 0" class="py-12 text-center text-xs text-zinc-500">
            暂无浏览记录，快去探索热门项目吧！
          </div>
        </div>

        <!-- Guest state for history -->
        <div v-else class="py-16 text-center space-y-3">
          <div class="w-12 h-12 mx-auto rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-xl text-zinc-500">
            🛡️
          </div>
          <div class="text-sm font-bold text-zinc-300">游客模式不记录浏览历史</div>
          <p class="text-xs text-zinc-500 max-w-xs mx-auto">
            登录 GitHub 后，系统将记录您在端内刷项目的有效停留与浏览轨迹，为后续 MapReduce 个性化推荐提供反馈依据。
          </p>
          <button
            @click="$emit('open-login')"
            class="px-4 py-2 rounded-xl bg-zinc-800 text-xs font-semibold text-rose-400 border border-rose-500/30 hover:bg-rose-500/10 transition"
          >
            登录以开启历史记录
          </button>
        </div>
      </div>

      <!-- 2. 我的 Star -->
      <div v-if="activeTab === 'stars'" class="space-y-3">
        <div v-if="userStore.isLoggedIn">
          <div
            v-for="repo in userStore.myStars"
            :key="repo.id"
            class="p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 transition"
          >
            <div class="flex items-start justify-between gap-2 mb-1">
              <h4 class="text-sm font-bold text-white hover:text-amber-400 cursor-pointer">
                {{ repo.name }}
              </h4>
              <span class="text-amber-400 text-xs font-mono font-medium">⭐ {{ repo.stars.toLocaleString() }}</span>
            </div>
            <p class="text-xs text-zinc-400 mb-2">{{ repo.desc }}</p>
            <div class="flex items-center justify-between text-[10px] text-zinc-500">
              <span class="flex items-center gap-1 text-zinc-400">
                <span class="w-2 h-2 rounded-full bg-sky-400"></span>
                {{ repo.language }}
              </span>
              <span>更新于 {{ repo.updatedAt }}</span>
            </div>
          </div>
        </div>

        <!-- Guest state for stars -->
        <div v-else class="py-16 text-center space-y-3">
          <div class="w-12 h-12 mx-auto rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-xl text-zinc-500">
            ⭐
          </div>
          <div class="text-sm font-bold text-zinc-300">登录同步 GitHub Star</div>
          <p class="text-xs text-zinc-500 max-w-xs mx-auto">
            登录后即可在此处直接查看与管理您在 GitHub 上 Star 过的所有开源项目。
          </p>
          <button
            @click="$emit('open-login')"
            class="px-4 py-2 rounded-xl bg-zinc-800 text-xs font-semibold text-amber-400 border border-amber-500/30 hover:bg-amber-500/10 transition"
          >
            立即登录同步
          </button>
        </div>
      </div>

      <!-- 3. 我的项目 -->
      <div v-if="activeTab === 'projects'" class="space-y-3">
        <div v-if="userStore.isLoggedIn">
          <div class="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 leading-relaxed mb-3">
            💡 系统根据开源协议（License）识别您的开源项目，排除闭源仓库后用于计算多维开发者画像。
          </div>

          <div
            v-for="proj in userStore.myProjects"
            :key="proj.id"
            class="p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 transition"
          >
            <div class="flex items-start justify-between gap-2 mb-1.5">
              <div class="flex items-center gap-2">
                <h4 class="text-sm font-bold text-white">{{ proj.name }}</h4>
                <span class="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  开源 ({{ proj.license }})
                </span>
              </div>
              <span class="text-xs text-zinc-400 font-mono">⭐ {{ proj.stars }}</span>
            </div>
            <p class="text-xs text-zinc-400 mb-2">{{ proj.desc }}</p>
            <div class="flex items-center justify-between text-[11px] text-zinc-400">
              <span class="flex items-center gap-1">
                <span class="w-2 h-2 rounded-full bg-purple-400"></span>
                {{ proj.language }}
              </span>
              <span class="text-[10px] text-zinc-500">已纳入画像特征库</span>
            </div>
          </div>
        </div>

        <!-- Guest state for projects -->
        <div v-else class="py-16 text-center space-y-3">
          <div class="w-12 h-12 mx-auto rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-xl text-zinc-500">
            📦
          </div>
          <div class="text-sm font-bold text-zinc-300">展示您的原创开源项目</div>
          <p class="text-xs text-zinc-500 max-w-xs mx-auto">
            登录后，系统会自动抓取您的公开开源仓库，排除闭源项目后提取词元生成多维画像。
          </p>
          <button
            @click="$emit('open-login')"
            class="px-4 py-2 rounded-xl bg-zinc-800 text-xs font-semibold text-rose-400 border border-rose-500/30 hover:bg-rose-500/10 transition"
          >
            登录接入开源项目
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useUserStore } from '../stores/user'

const emit = defineEmits(['edit-profile', 'open-settings', 'open-login'])

const userStore = useUserStore()
const user = computed(() => userStore.user)

const activeTab = ref('history')

const tabs = computed(() => [
  { id: 'history', label: '浏览历史', count: userStore.browseHistory.length },
  { id: 'stars', label: '我的 Star', count: userStore.myStars.length },
  { id: 'projects', label: '我的项目', count: userStore.myProjects.length }
])
</script>

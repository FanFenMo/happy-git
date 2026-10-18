<template>
  <div class="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] flex flex-col items-center justify-center p-0 md:p-6 font-sans antialiased">
    <!-- Desktop Shell Wrapper (Responsive Container for Win / Mac / Linux / Web) -->
    <main
      class="w-full h-screen md:h-[860px] md:max-w-[420px] bg-[var(--color-bg)] md:rounded-[40px] md:border-2 md:border-[var(--color-border)] md:shadow-2xl flex flex-col overflow-hidden relative"
    >
      <!-- Dynamic View Area -->
      <section class="flex-1 overflow-hidden flex flex-col">
        <!-- 1. 热门项目 -->
        <TrendingView
          v-if="currentNav === 'trending'"
          @request-login="isLoginModalOpen = true"
        />

        <!-- 2. 我的主页 -->
        <ProfileView
          v-else-if="currentNav === 'profile'"
          @edit-profile="isEditModalOpen = true"
          @open-settings="isSettingsModalOpen = true"
          @open-login="isLoginModalOpen = true"
        />
      </section>

      <!-- Bottom Navigation Bar (下方UI显示热门项目，我的两个部分) -->
      <nav class="h-16 bg-[var(--color-surface)] border-t border-[var(--color-border)] flex items-center justify-around px-6 z-30 no-select">
        <!-- 热门项目 Tab -->
        <button
          @click="currentNav = 'trending'"
          :class="[
            'flex flex-col items-center justify-center gap-1 transition-all duration-150 cursor-pointer',
            currentNav === 'trending' ? 'text-[var(--color-primary)] font-bold' : 'text-[var(--color-text-subtle)] hover:text-[var(--color-text-muted)]'
          ]"
        >
          <div class="relative">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <span class="text-xs">热门项目</span>
        </button>

        <!-- 我的 Tab -->
        <button
          @click="currentNav = 'profile'"
          :class="[
            'flex flex-col items-center justify-center gap-1 transition-all duration-150 cursor-pointer',
            currentNav === 'profile' ? 'text-[var(--color-primary)] font-bold' : 'text-[var(--color-text-subtle)] hover:text-[var(--color-text-muted)]'
          ]"
        >
          <div class="relative">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <span
              v-if="!userStore.hasAccount"
              class="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--color-text-subtle)]"
            ></span>
          </div>
          <span class="text-xs">{{ userStore.hasAccount ? '我的' : '我的(游客)' }}</span>
        </button>
      </nav>

      <!-- 弹窗组件 -->
      <EditProfileModal
        :is-open="isEditModalOpen"
        @close="isEditModalOpen = false"
      />

      <SettingsModal
        :is-open="isSettingsModalOpen"
        @close="isSettingsModalOpen = false"
        @open-login="isLoginModalOpen = true"
      />

      <!-- GitHub 设备码登录弹窗 -->
      <LoginModal
        :is-open="isLoginModalOpen"
        @close="isLoginModalOpen = false"
        @skip="handleSkipLogin"
      />
    </main>

    <!-- Desktop helper banner (仅在桌面端提示) -->
    <aside class="hidden md:flex items-center gap-3 mt-4 text-xs text-[var(--color-text-subtle)] no-select">
      <span>HappyGit 跨平台客户端 (Windows / Android)</span>
      <span>•</span>
      <span v-if="!userStore.hasAccount" class="text-[var(--color-text-muted)]">当前为游客模式</span>
      <button @click="isLoginModalOpen = true" class="hover:text-[var(--color-text)] transition underline underline-offset-4 cursor-pointer">
        {{ userStore.hasAccount ? '切换 GitHub 账号' : '登录 GitHub 账号' }}
      </button>
    </aside>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useUserStore } from './stores/user'
import TrendingView from './components/TrendingView.vue'
import ProfileView from './components/ProfileView.vue'
import EditProfileModal from './components/EditProfileModal.vue'
import SettingsModal from './components/SettingsModal.vue'
import LoginModal from './components/LoginModal.vue'

const userStore = useUserStore()

const currentNav = ref('trending')
const isLoginModalOpen = ref(false)
const isEditModalOpen = ref(false)
const isSettingsModalOpen = ref(false)

onMounted(async () => {
  const initResult = await userStore.initialize()
  if (initResult.shouldPromptLogin) {
    isLoginModalOpen.value = true
  }
})

// 监听登录成功：当 session.status 变为 authenticated 且弹窗处于打开状态时自动关闭
watch(
  () => userStore.session?.status,
  (status) => {
    if (status === 'authenticated') {
      isLoginModalOpen.value = false
    }
  }
)

const handleSkipLogin = () => {
  isLoginModalOpen.value = false
  currentNav.value = 'trending'
}
</script>

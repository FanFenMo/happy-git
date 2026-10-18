<template>
  <div class="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center p-0 md:p-6 font-sans antialiased">
    <!-- Desktop Shell Wrapper (Responsive Container for Win / Mac / Linux / Web) -->
    <main
      class="w-full h-screen md:h-[860px] md:max-w-[420px] bg-zinc-950 md:rounded-[40px] md:border-4 md:border-zinc-800 md:shadow-[0_0_50px_rgba(0,0,0,0.8)] flex flex-col overflow-hidden relative"
    >
      <!-- Dynamic View Area -->
      <section class="flex-1 overflow-hidden flex flex-col">
        <!-- 1. 热门项目 -->
        <TrendingView v-if="currentNav === 'trending'" />

        <!-- 2. 我的 (类似抖音个人主页) -->
        <ProfileView
          v-else-if="currentNav === 'profile'"
          @edit-profile="isEditModalOpen = true"
          @open-settings="isSettingsModalOpen = true"
        />
      </section>

      <!-- Bottom Navigation Bar (下方UI显示热门项目，我的两个部分) -->
      <nav class="h-16 bg-zinc-950/90 backdrop-blur border-t border-zinc-800/80 flex items-center justify-around px-6 z-30 select-none">
        <!-- 热门项目 Tab -->
        <button
          @click="currentNav = 'trending'"
          :class="[
            'flex flex-col items-center justify-center gap-1 transition-all duration-200',
            currentNav === 'trending' ? 'text-white scale-105' : 'text-zinc-500 hover:text-zinc-300'
          ]"
        >
          <div class="relative">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span
              v-if="currentNav === 'trending'"
              class="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-rose-500 animate-ping"
            ></span>
          </div>
          <span class="text-xs font-semibold">热门项目</span>
        </button>

        <!-- 我的 Tab -->
        <button
          @click="currentNav = 'profile'"
          :class="[
            'flex flex-col items-center justify-center gap-1 transition-all duration-200',
            currentNav === 'profile' ? 'text-white scale-105' : 'text-zinc-500 hover:text-zinc-300'
          ]"
        >
          <div class="relative">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <span class="text-xs font-semibold">我的</span>
        </button>
      </nav>

      <!-- Modals -->
      <EditProfileModal
        :is-open="isEditModalOpen"
        :user="userStore.user"
        @close="isEditModalOpen = false"
        @save="handleSaveProfile"
      />

      <SettingsModal
        :is-open="isSettingsModalOpen"
        @close="isSettingsModalOpen = false"
        @logout="handleLogout"
        @clear-history="userStore.clearHistory"
      />

      <LoginModal
        :is-open="!userStore.isLoggedIn"
        @login="handleLogin"
      />
    </main>

    <!-- Desktop helper banner (hidden on mobile) -->
    <aside class="hidden md:flex items-center gap-4 mt-4 text-xs text-zinc-500">
      <span>HappyGit 跨平台客户端 (适配 Android / iOS / Win / Mac / Linux)</span>
      <span>•</span>
      <button @click="isLoginModalOpen = true" class="hover:text-zinc-300 transition">切换 GitHub 用户</button>
    </aside>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useUserStore } from './stores/user'
import TrendingView from './components/TrendingView.vue'
import ProfileView from './components/ProfileView.vue'
import EditProfileModal from './components/EditProfileModal.vue'
import SettingsModal from './components/SettingsModal.vue'
import LoginModal from './components/LoginModal.vue'

const userStore = useUserStore()

// Navigation state: 'trending' or 'profile'
const currentNav = ref('profile') // Default to 'profile' so the user immediately sees the Douyin-style home page

// Modals
const isEditModalOpen = ref(false)
const isSettingsModalOpen = ref(false)
const isLoginModalOpen = ref(false)

const handleSaveProfile = (updated) => {
  userStore.updateProfile(updated)
}

const handleLogout = () => {
  userStore.logout()
  isSettingsModalOpen.value = false
}

const handleLogin = async (username) => {
  await userStore.loginWithGitHub(username)
  isLoginModalOpen.value = false
}
</script>

<template>
  <div class="application-shell">
    <aside class="application-sidebar no-select">
      <div class="application-brand">Happy<span>Git</span><small>开源项目探索</small></div>
      <nav aria-label="主导航">
        <button :class="{ active: currentNav === 'trending' }" :aria-current="currentNav === 'trending' ? 'page' : undefined" @click="currentNav = 'trending'">发现项目</button>
        <button :class="{ active: currentNav === 'profile' }" :aria-current="currentNav === 'profile' ? 'page' : undefined" @click="currentNav = 'profile'">我的空间</button>
      </nav>
      <p class="sidebar-caption">从技术兴趣出发，找到适合学习、使用与贡献的开源项目。</p>
      <button class="btn-secondary px-4 text-sm" @click="isLoginModalOpen = true">{{ userStore.hasAccount ? '切换 GitHub 账号' : '连接 GitHub' }}</button>
    </aside>
    <main class="application-main">
      <header class="application-header">
        <div>
          <p class="application-eyebrow">{{ currentNav === 'trending' ? 'OPEN SOURCE DISCOVERY' : 'PERSONAL SPACE' }}</p>
          <h1>{{ currentNav === 'trending' ? '发现下一份开源灵感' : '我的项目与技术兴趣' }}</h1>
          <p class="application-description">{{ currentNav === 'trending' ? '了解项目用途、技术栈与社区关注，找到值得进一步探索的项目。' : '管理 GitHub 公开资料、兴趣偏好与当前设备的浏览记录。' }}</p>
        </div>
        <span class="account-status">{{ userStore.needsReauth ? '需要重新登录' : userStore.isOffline ? '离线模式' : userStore.hasAccount ? 'GitHub 已连接' : '游客浏览' }}</span>
      </header>
      <section class="application-content" aria-label="当前页面">
        <TrendingView v-if="currentNav === 'trending'" @request-login="isLoginModalOpen = true" />
        <ProfileView v-else @edit-profile="isEditModalOpen = true" @open-settings="isSettingsModalOpen = true" @open-login="isLoginModalOpen = true" />
      </section>
      <nav class="application-mobile-nav no-select" aria-label="移动端主导航">
        <button :class="{ active: currentNav === 'trending' }" :aria-current="currentNav === 'trending' ? 'page' : undefined" @click="currentNav = 'trending'">发现项目</button>
        <button :class="{ active: currentNav === 'profile' }" :aria-current="currentNav === 'profile' ? 'page' : undefined" @click="currentNav = 'profile'">{{ userStore.hasAccount ? '我的空间' : '我的 · 游客' }}</button>
      </nav>
    </main>
    <EditProfileModal :is-open="isEditModalOpen" @close="isEditModalOpen = false" />
    <SettingsModal :is-open="isSettingsModalOpen" @close="isSettingsModalOpen = false" @open-login="isLoginModalOpen = true" />
    <LoginModal :is-open="isLoginModalOpen" @close="isLoginModalOpen = false" @skip="handleSkipLogin" />
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
  if (initResult.shouldPromptLogin) isLoginModalOpen.value = true
})
watch(() => userStore.session?.contextId, () => {
  if (userStore.session.status === 'authenticated') isLoginModalOpen.value = false
})
const handleSkipLogin = () => {
  isLoginModalOpen.value = false
  currentNav.value = 'trending'
}
</script>

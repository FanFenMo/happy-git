<template>
  <div class="application-shell" :data-platform="nativeBridge.getPlatform()">
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <aside class="application-sidebar no-select">
      <div class="application-brand">
        <span class="brand-mark" aria-hidden="true"><GitFork :size="24" :stroke-width="1.8" /></span>
        <div>HappyGit<small>开源项目探索</small></div>
      </div>
      <nav aria-label="主导航">
        <button type="button" :class="{ active: currentNav === 'trending' }" :aria-current="currentNav === 'trending' ? 'page' : undefined" @click="currentNav = 'trending'">
          <Compass :size="20" aria-hidden="true" />发现项目
        </button>
        <button type="button" :class="{ active: currentNav === 'profile' }" :aria-current="currentNav === 'profile' ? 'page' : undefined" @click="currentNav = 'profile'">
          <UserRound :size="20" aria-hidden="true" />我的空间
        </button>
      </nav>
      <div class="sidebar-utilities">
        <button type="button" class="sidebar-settings" @click="isSettingsModalOpen = true"><Settings2 :size="20" aria-hidden="true" />设置</button>
        <button type="button" class="btn-secondary sidebar-account" @click="isLoginModalOpen = true">
          <Github :size="18" aria-hidden="true" />{{ userStore.hasAccount ? '切换 GitHub 账号' : '连接 GitHub' }}
        </button>
      </div>
    </aside>

    <main id="main-content" class="application-main" tabindex="-1">
      <header class="application-header">
        <div class="application-heading">
          <h1>{{ currentNav === 'trending' ? '发现项目' : '我的空间' }}</h1>
          <p class="application-description">{{ currentNav === 'trending' ? '探索值得学习、使用与贡献的开源项目。' : '管理你的项目、技术兴趣与浏览记录。' }}</p>
        </div>
        <div class="application-header-actions">
          <span class="account-status">{{ userStore.needsReauth ? '需要重新登录' : userStore.isOffline ? '离线模式' : userStore.hasAccount ? 'GitHub 已连接' : '游客浏览' }}</span>
          <button v-if="currentNav === 'trending'" type="button" class="icon-button header-settings" aria-label="打开设置" title="设置" @click="isSettingsModalOpen = true"><Settings2 :size="20" aria-hidden="true" /></button>
        </div>
      </header>
      <section class="application-content" aria-label="当前页面">
        <TrendingView v-if="currentNav === 'trending'" @request-login="isLoginModalOpen = true" />
        <ProfileView v-else @edit-profile="isEditModalOpen = true" @open-settings="isSettingsModalOpen = true" @open-login="isLoginModalOpen = true" />
      </section>
    </main>

    <nav class="application-mobile-nav no-select" aria-label="主导航">
      <button type="button" :class="{ active: currentNav === 'trending' }" :aria-current="currentNav === 'trending' ? 'page' : undefined" @click="currentNav = 'trending'">
        <Compass :size="23" :stroke-width="currentNav === 'trending' ? 2.2 : 1.7" aria-hidden="true" /><span>发现项目</span>
      </button>
      <button type="button" :class="{ active: currentNav === 'profile' }" :aria-current="currentNav === 'profile' ? 'page' : undefined" @click="currentNav = 'profile'">
        <UserRound :size="23" :stroke-width="currentNav === 'profile' ? 2.2 : 1.7" aria-hidden="true" /><span>{{ userStore.hasAccount ? '我的空间' : '我的 · 游客' }}</span>
      </button>
    </nav>

    <EditProfileModal :is-open="isEditModalOpen" @close="isEditModalOpen = false" />
    <SettingsModal :is-open="isSettingsModalOpen" @close="isSettingsModalOpen = false" @open-login="isLoginModalOpen = true" />
    <LoginModal :is-open="isLoginModalOpen" @close="isLoginModalOpen = false" @skip="handleSkipLogin" />
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { Compass, GitFork, Github, Settings2, UserRound } from 'lucide-vue-next'
import { nativeBridge } from './platform'
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

function handleNativeBack(event) {
  const dialogs = document.querySelectorAll('dialog[open]')
  const activeDialog = dialogs[dialogs.length - 1]
  if (activeDialog) {
    const cancel = new Event('cancel', { cancelable: true })
    activeDialog.dispatchEvent(cancel)
    if (!cancel.defaultPrevented) activeDialog.close()
    event.preventDefault()
  } else if (currentNav.value !== 'trending') {
    currentNav.value = 'trending'
    event.preventDefault()
  }
}

onMounted(async () => {
  window.addEventListener('happygit:native-back', handleNativeBack)
  const initResult = await userStore.initialize()
  if (initResult.shouldPromptLogin) isLoginModalOpen.value = true
})
onBeforeUnmount(() => window.removeEventListener('happygit:native-back', handleNativeBack))
watch(() => userStore.session?.contextId, () => {
  if (userStore.session.status === 'authenticated') isLoginModalOpen.value = false
})
const handleSkipLogin = () => {
  isLoginModalOpen.value = false
  currentNav.value = 'trending'
}
</script>

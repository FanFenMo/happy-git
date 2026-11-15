<template>
  <AppDialog :is-open="isOpen" label="应用设置" :sheet="true" class="settings-dialog" @close="$emit('close')">
    <header class="settings-header">
      <div>
        <h2 class="dialog-title flex items-center gap-2" tabindex="-1" autofocus>
          <Settings2 :size="22" aria-hidden="true" />
          设置
        </h2>
        <p class="settings-row-description mt-1">管理账号与当前设备上的数据</p>
      </div>
      <button type="button" aria-label="关闭应用设置" class="icon-button shrink-0" @click="$emit('close')">
        <X :size="20" aria-hidden="true" />
      </button>
    </header>

    <div class="settings-body">
      <section class="settings-group" aria-labelledby="settings-account-heading">
        <h3 id="settings-account-heading" class="settings-group-title flex items-center gap-2">
          <UserRound :size="18" aria-hidden="true" />
          账号
        </h3>
        <div class="settings-row">
          <div class="settings-row-copy min-w-0">
            <p class="settings-row-label break-words selectable">
              {{ userStore.hasAccount ? (userStore.profile?.displayName || userStore.profile?.login) : '游客模式' }}
            </p>
            <p class="settings-row-description break-words">
              {{ userStore.hasAccount ? `@${userStore.profile?.login || 'GitHub'}` : '连接 GitHub，查看你的项目与 Star' }}
            </p>
          </div>
          <button
            v-if="userStore.hasAccount"
            type="button"
            :disabled="isSyncing"
            :aria-busy="isSyncing"
            class="btn-secondary px-4 gap-2 shrink-0"
            @click="handleManualSync"
          >
            <RefreshCw :size="16" :class="{ 'animate-spin': isSyncing }" aria-hidden="true" />
            {{ isSyncing ? '同步中…' : '手动同步' }}
          </button>
          <button v-else type="button" class="btn-secondary px-4 shrink-0" @click="openLogin">
            连接 GitHub
          </button>
        </div>
      </section>

      <section class="settings-group" aria-labelledby="settings-privacy-heading">
        <h3 id="settings-privacy-heading" class="settings-group-title flex items-center gap-2">
          <ShieldCheck :size="18" aria-hidden="true" />
          隐私与本机数据
        </h3>
        <div class="settings-row settings-history-row">
          <div class="settings-row-copy">
            <p id="history-enabled-label" class="settings-row-label">记录浏览历史</p>
            <p id="history-enabled-description" class="settings-row-description">保存在当前设备，可随时关闭或清空。</p>
          </div>
          <label class="switch-control shrink-0">
            <input
              id="settings-history-enabled"
              type="checkbox"
              role="switch"
              aria-labelledby="history-enabled-label"
              aria-describedby="history-enabled-description"
              :checked="userStore.preferences.historyEnabled"
              class="switch-input sr-only"
              @change="toggleHistory"
            />
            <span class="switch-track" aria-hidden="true"></span>
          </label>
        </div>
        <div class="settings-row">
          <div class="settings-row-copy">
            <p class="settings-row-label">清空浏览历史</p>
            <p class="settings-row-description">
              {{ userStore.hasAccount ? '仅清除当前账号在此设备上的访问记录。' : '仅清除游客模式在此设备上的访问记录。' }}
            </p>
          </div>
          <button type="button" class="btn-secondary px-4 shrink-0" @click="handleClearHistory">清空历史</button>
        </div>
        <div v-if="userStore.hasAccount" class="settings-row">
          <div class="settings-row-copy">
            <p class="settings-row-label">删除本账号的本机数据</p>
            <p class="settings-row-description">删除此设备上的账号资料、偏好与浏览记录，并退出登录。</p>
          </div>
          <button type="button" class="btn-danger px-4 shrink-0" @click="handleForgetAccount">删除并退出</button>
        </div>
      </section>

      <section class="settings-group" aria-labelledby="settings-about-heading">
        <h3 id="settings-about-heading" class="settings-group-title flex items-center gap-2">
          <Info :size="18" aria-hidden="true" />
          关于 HappyGit
        </h3>
        <div class="settings-row">
          <p class="settings-row-label">应用版本</p>
          <p class="settings-row-value">1.0.0</p>
        </div>
        <div class="settings-row">
          <div class="settings-row-copy">
            <p class="settings-row-label">当前设备存储</p>
            <p class="settings-row-description">账号偏好与浏览历史保存在此设备。退出账号会保留数据，删除本机数据则会将其清除。</p>
          </div>
        </div>
      </section>

      <p v-if="feedback" role="status" class="text-[0.875rem] leading-relaxed text-[var(--color-danger)]">{{ feedback }}</p>
    </div>

    <footer class="settings-footer">
      <button v-if="userStore.hasAccount" type="button" class="btn-danger px-4" @click="handleLogout">退出当前账号</button>
      <button type="button" class="btn-primary px-6 ml-auto" @click="$emit('close')">完成</button>
    </footer>
  </AppDialog>
</template>

<script setup>
import { ref } from 'vue'
import { Info, RefreshCw, Settings2, ShieldCheck, UserRound, X } from 'lucide-vue-next'
import AppDialog from './AppDialog.vue'
import { useUserStore } from '../stores/user'
import { useHistoryStore } from '../stores/history'

defineProps({
  isOpen: Boolean
})

const emit = defineEmits(['close', 'open-login'])

const userStore = useUserStore()
const historyStore = useHistoryStore()
const isSyncing = ref(false)
const feedback = ref('')

const openLogin = () => {
  emit('close')
  emit('open-login')
}

const toggleHistory = async (e) => {
  const enabled = e.target.checked
  feedback.value = ''
  try { await userStore.setHistoryEnabled(enabled) }
  catch (error) { e.target.checked = !enabled; feedback.value = error.message }
}

const handleManualSync = async () => {
  if (isSyncing.value) return
  isSyncing.value = true
  try {
    await userStore.refreshAccountData()
  } finally {
    isSyncing.value = false
  }
}

const handleClearHistory = async () => {
  if (window.confirm('仅删除本机当前账号的浏览历史？')) {
    await historyStore.clearAll()
  }
}

const handleForgetAccount = async () => {
  if (window.confirm('将删除本账号在当前设备上的所有本地快照、浏览历史与偏好设置并退出登录，是否继续？')) {
    try { await userStore.forgetAccount(); emit('close') }
    catch (error) { feedback.value = error.message }
  }
}

const handleLogout = async () => {
  if (window.confirm('确定退出当前 GitHub 账号？（本地历史将保留）')) {
    try { await userStore.logout(); emit('close') }
    catch (error) { feedback.value = error.message }
  }
}
</script>

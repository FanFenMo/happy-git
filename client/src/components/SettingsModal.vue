<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in no-select">
    <div class="w-full max-w-md modal-surface p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
      <!-- Header -->
      <div class="flex items-center justify-between pb-4 border-b border-[var(--color-border)] mb-4">
        <h3 class="text-base font-bold text-[var(--color-text)] flex items-center gap-2">
          <span>⚙️</span> 系统设置
        </h3>
        <button
          @click="$emit('close')"
          class="p-1 rounded-full text-[var(--color-text-subtle)] hover:text-white hover:bg-[var(--color-surface-raised)] transition cursor-pointer"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Settings Content -->
      <div class="space-y-4">
        <!-- 账号信息与同步 -->
        <div class="p-4 rounded-2xl card-raised border border-[var(--color-border)] space-y-3">
          <div class="text-xs font-semibold text-[var(--color-text-muted)]">账号状态</div>
          <div class="flex items-center justify-between">
            <div class="min-w-0">
              <div class="text-sm font-bold text-[var(--color-text)] truncate selectable">
                {{ userStore.hasAccount ? (userStore.profile?.displayName || userStore.profile?.login) : '游客模式' }}
              </div>
              <div class="text-[11px] text-[var(--color-text-subtle)] truncate font-mono">
                {{ userStore.hasAccount ? `@${userStore.profile?.login || 'GitHub'}` : '未连接个人账号' }}
              </div>
            </div>

            <div class="flex items-center gap-2">
              <button
                v-if="userStore.hasAccount"
                @click="handleManualSync"
                :disabled="isSyncing"
                class="px-3 py-1.5 rounded-xl btn-secondary text-xs cursor-pointer !min-h-0"
              >
                {{ isSyncing ? '同步中...' : '手动同步' }}
              </button>
              <button
                v-else
                @click="openLogin"
                class="px-3 py-1.5 rounded-xl btn-primary text-xs cursor-pointer !min-h-0"
              >
                立即登录
              </button>
            </div>
          </div>
        </div>

        <!-- 隐私与数据存储 -->
        <div class="p-4 rounded-2xl card-raised border border-[var(--color-border)] space-y-4">
          <div class="text-xs font-semibold text-[var(--color-text-muted)]">隐私与本地存储</div>

          <!-- 历史记录开关 -->
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-xs font-semibold text-[var(--color-text)]">记录本机浏览历史</div>
              <div class="text-[11px] text-[var(--color-text-subtle)]">仅保存在当前设备 SQLite，可随时关闭或清空</div>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                :checked="userStore.preferences.historyEnabled"
                @change="toggleHistory"
                class="sr-only peer"
              />
              <div class="w-9 h-5 bg-[var(--color-border)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--color-primary)]"></div>
            </label>
          </div>

          <div class="border-t border-[var(--color-border)] pt-3 flex items-center justify-between">
            <div>
              <div class="text-xs text-[var(--color-text)]">清空本机浏览历史</div>
              <div class="text-[11px] text-[var(--color-text-subtle)]">清除当前账号在本机的全部访问快照</div>
            </div>
            <button
              @click="handleClearHistory"
              class="px-3 py-1.5 rounded-xl btn-secondary text-xs text-[var(--color-danger)] hover:border-[var(--color-danger)] cursor-pointer !min-h-0"
            >
              清空
            </button>
          </div>

          <!-- 删除账号本地数据 -->
          <div v-if="userStore.hasAccount" class="border-t border-[var(--color-border)] pt-3 flex items-center justify-between">
            <div>
              <div class="text-xs text-[var(--color-danger)]">删除本账号本地数据</div>
              <div class="text-[11px] text-[var(--color-text-subtle)]">删除本机数据库中该账号的所有缓存与历史</div>
            </div>
            <button
              @click="handleForgetAccount"
              class="px-3 py-1.5 rounded-xl btn-danger text-xs cursor-pointer !min-h-0"
            >
              删除并退出
            </button>
          </div>
        </div>

        <!-- 关于应用 -->
        <div class="p-4 rounded-2xl card-raised border border-[var(--color-border)] space-y-2">
          <div class="text-xs font-semibold text-[var(--color-text-muted)] mb-1">关于应用</div>
          <div class="flex items-center justify-between text-xs">
            <span class="text-[var(--color-text-subtle)]">应用版本</span>
            <span class="text-[var(--color-text)] font-mono">v1.0.0 (双端正式版)</span>
          </div>
          <div class="flex items-center justify-between text-xs">
            <span class="text-[var(--color-text-subtle)]">平台支持</span>
            <span class="text-[var(--color-text)]">Windows (Electron) / Android (Capacitor)</span>
          </div>
          <div class="flex items-center justify-between text-xs">
            <span class="text-[var(--color-text-subtle)]">存储引擎</span>
            <span class="text-[var(--color-text)]">本地 SQLite (安全隔离)</span>
          </div>
        </div>
      </div>

      <!-- Footer Buttons -->
      <div class="flex items-center justify-between mt-5 pt-4 border-t border-[var(--color-border)]">
        <button
          v-if="userStore.hasAccount"
          @click="handleLogout"
          class="btn-danger px-3 py-2 text-xs cursor-pointer !min-h-0"
        >
          退出当前账号
        </button>
        <div v-else></div>

        <button
          @click="$emit('close')"
          class="btn-secondary px-5 py-2 text-xs cursor-pointer !min-h-0"
        >
          完成
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useUserStore } from '../stores/user'
import { useHistoryStore } from '../stores/history'

defineProps({
  isOpen: Boolean
})

const emit = defineEmits(['close', 'open-login'])

const userStore = useUserStore()
const historyStore = useHistoryStore()
const isSyncing = ref(false)

const openLogin = () => {
  emit('close')
  emit('open-login')
}

const toggleHistory = async (e) => {
  const enabled = e.target.checked
  await userStore.setHistoryEnabled(enabled)
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
    await userStore.forgetAccount()
    emit('close')
  }
}

const handleLogout = async () => {
  if (window.confirm('确定退出当前 GitHub 账号？（本地历史将保留）')) {
    await userStore.logout()
    emit('close')
  }
}
</script>

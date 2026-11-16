<template>
  <div v-if="isOpen" class="application-overlay settings-overlay fixed inset-0 z-50 no-select" role="dialog" aria-modal="true" aria-label="应用设置">
    <div class="w-full max-w-md modal-surface p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
      <!-- Header -->
      <div class="flex items-center justify-between pb-4 border-b border-[var(--color-border)] mb-4">
        <h3 class="text-base font-bold text-[var(--color-text)] flex items-center gap-2">
          <span>⚙️</span> 系统设置
        </h3>
        <button
          aria-label="关闭应用设置"
          @click="$emit('close')"
          class="p-1 rounded-full text-[var(--color-text-subtle)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-raised)] transition cursor-pointer"
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

        <!-- 1. 本地浏览历史 -->
        <div class="p-4 rounded-2xl card-raised border border-[var(--color-border)] space-y-3">
          <div class="text-xs font-semibold text-[var(--color-text-muted)]">1. 本地浏览历史</div>
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-xs font-semibold text-[var(--color-text)]">记录并展示本机浏览历史</div>
              <div class="text-[11px] text-[var(--color-text-subtle)]">控制当前设备 SQLite 是否保存仓库浏览记录与 30 秒有效访问计数</div>
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
        </div>

        <!-- 2. 云端兴趣分析与行为上传 -->
        <div class="p-4 rounded-2xl card-raised border border-[var(--color-border)] space-y-3">
          <div class="flex items-center justify-between">
            <div class="text-xs font-semibold text-[var(--color-text-muted)]">2. 云端兴趣分析与行为上传</div>
            <span
              v-if="userStore.hasAccount"
              class="text-[11px] font-mono px-2 py-0.5 rounded-full bg-[var(--color-surface)] text-[var(--color-text-subtle)]"
            >
              Epoch #{{ userStore.cloudSync.analysisEpoch || 1 }}
            </span>
          </div>

          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-xs font-semibold text-[var(--color-text)]">参与云端兴趣画像分析并上传行为</div>
              <div class="text-[11px] text-[var(--color-text-subtle)]">控制是否将新有效浏览事件与完整 Star/自有仓库快照上传至服务端参与离线画像计算</div>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                :checked="userStore.preferences.analysisEnabled"
                @change="toggleAnalysis"
                class="sr-only peer"
              />
              <div class="w-9 h-5 bg-[var(--color-border)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--color-primary)]"></div>
            </label>
          </div>

          <div v-if="userStore.hasAccount" class="border-t border-[var(--color-border)] pt-3 space-y-2">
            <div class="flex items-center justify-between">
              <div class="text-[11px] text-[var(--color-text-subtle)]">
                云端会话状态：
                <span class="font-semibold text-[var(--color-text)]">
                  {{
                    userStore.cloudSync.cloudBound && userStore.cloudSync.accountMatched
                      ? '已绑定同账号会话'
                      : (userStore.cloudSync.cloudAccountId && !userStore.cloudSync.accountMatched
                          ? '账号不一致（已阻止上传）'
                          : '未绑定云端会话')
                  }}
                </span>
              </div>
              <div class="flex items-center gap-2">
                <button
                  v-if="userStore.cloudSync.cloudBound"
                  @click="handleFlushCloud"
                  :disabled="isFlushingCloud"
                  class="px-2.5 py-1 rounded-lg btn-secondary text-[11px] cursor-pointer !min-h-0"
                >
                  {{ isFlushingCloud ? '上传中...' : '立即上传' }}
                </button>
                <button
                  v-if="userStore.cloudSync.cloudBound"
                  @click="handleUnbindCloud"
                  class="px-2.5 py-1 rounded-lg btn-secondary text-[11px] cursor-pointer !min-h-0"
                >
                  解绑云端
                </button>
                <button
                  v-else
                  @click="handleBindCloud"
                  :disabled="userStore.cloudAuthStage === 'authorizing'"
                  class="px-2.5 py-1 rounded-lg btn-primary text-[11px] cursor-pointer !min-h-0"
                >
                  {{ userStore.cloudAuthStage === 'authorizing' ? '授权中...' : '绑定云端会话' }}
                </button>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-2 text-[11px] font-mono bg-[var(--color-surface)] p-2.5 rounded-xl">
              <div>待上传队列 (pending): {{ userStore.cloudSync.pendingCount || 0 }}</div>
              <div>上传已确认 (accepted): {{ userStore.cloudSync.acceptedThrough || 0 }}</div>
              <div>已导出 HDFS (exported): {{ userStore.cloudSync.exportedThrough || 0 }}</div>
              <div>画像已消费 (processed): {{ userStore.cloudSync.processedThrough || 0 }}</div>
            </div>
          </div>
        </div>

        <!-- 3. 数据清除范围 -->
        <div class="p-4 rounded-2xl card-raised border border-[var(--color-border)] space-y-3">
          <div class="text-xs font-semibold text-[var(--color-text-muted)]">3. 数据清除范围（本地与云端严格分离）</div>

          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-xs text-[var(--color-text)]">仅清空本地浏览历史</div>
              <div class="text-[11px] text-[var(--color-text-subtle)]">删除本机 SQLite 浏览历史并将本机未上传事件转为 discard 墓碑，不重置云端历史画像周期</div>
            </div>
            <button
              @click="handleClearHistory"
              class="px-3 py-1.5 rounded-xl btn-secondary text-xs text-[var(--color-danger)] hover:border-[var(--color-danger)] cursor-pointer !min-h-0"
            >
              清空本地历史
            </button>
          </div>

          <div v-if="userStore.hasAccount" class="border-t border-[var(--color-border)] pt-3 flex items-center justify-between gap-3">
            <div>
              <div class="text-xs text-[var(--color-text)]">清除云端分析数据并重置 analysisEpoch</div>
              <div class="text-[11px] text-[var(--color-text-subtle)]">递增云端与本地 analysisEpoch 使旧周期云端事件与集合快照失效，同时保留本机浏览历史</div>
            </div>
            <button
              @click="handleResetCloudAnalysis"
              :disabled="isResettingAnalysis"
              class="px-3 py-1.5 rounded-xl btn-secondary text-xs text-[var(--color-danger)] hover:border-[var(--color-danger)] cursor-pointer !min-h-0"
            >
              {{ isResettingAnalysis ? '重置中...' : '重置云端分析' }}
            </button>
          </div>

          <!-- 删除账号本地数据 -->
          <div v-if="userStore.hasAccount" class="border-t border-[var(--color-border)] pt-3 flex items-center justify-between gap-3">
            <div>
              <div class="text-xs text-[var(--color-danger)]">删除本账号本地数据并退出</div>
              <div class="text-[11px] text-[var(--color-text-subtle)]">清除本机数据库中该账号的所有本地缓存、浏览历史与云端会话凭据</div>
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
            <span class="text-[var(--color-text)] font-mono">v1.1.0 (双端云协同版)</span>
          </div>
          <div class="flex items-center justify-between text-xs">
            <span class="text-[var(--color-text-subtle)]">平台支持</span>
            <span class="text-[var(--color-text)]">Windows (Electron) / Android (Capacitor)</span>
          </div>
          <div class="flex items-center justify-between text-xs">
            <span class="text-[var(--color-text-subtle)]">存储引擎</span>
            <span class="text-[var(--color-text)]">本地 SQLite v3 + 云端事件队列</span>
          </div>
        </div>
      </div>

      <p v-if="feedback" role="status" class="mt-3 text-xs text-[var(--color-danger)]">{{ feedback }}</p>
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
const isFlushingCloud = ref(false)
const isResettingAnalysis = ref(false)
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

const toggleAnalysis = async (e) => {
  const enabled = e.target.checked
  feedback.value = ''
  try { await userStore.setAnalysisEnabled(enabled) }
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

const handleBindCloud = async () => {
  feedback.value = ''
  try {
    await userStore.startCloudBind()
  } catch (error) {
    feedback.value = error.message
  }
}

const handleUnbindCloud = async () => {
  feedback.value = ''
  try {
    await userStore.unbindCloudSession()
  } catch (error) {
    feedback.value = error.message
  }
}

const handleFlushCloud = async () => {
  if (isFlushingCloud.value) return
  isFlushingCloud.value = true
  feedback.value = ''
  try {
    await userStore.flushCloudEvents()
  } catch (error) {
    feedback.value = error.message
  } finally {
    isFlushingCloud.value = false
  }
}

const handleClearHistory = async () => {
  if (window.confirm('仅删除本机当前账号的浏览历史？（未确认的待上传浏览事件将转为 discard 墓碑，不重置云端分析周期）')) {
    await historyStore.clearAll()
    await userStore.refreshCloudSyncState()
  }
}

const handleResetCloudAnalysis = async () => {
  if (window.confirm('确定清除云端分析数据并递增 analysisEpoch？（本机浏览历史将保留，旧周期云端事件不再参与画像计算）')) {
    isResettingAnalysis.value = true
    feedback.value = ''
    try {
      await userStore.resetCloudAnalysisData()
    } catch (error) {
      feedback.value = error.message
    } finally {
      isResettingAnalysis.value = false
    }
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

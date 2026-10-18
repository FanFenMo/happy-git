<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in no-select">
    <div class="w-full max-w-sm modal-surface p-6 shadow-2xl relative text-center">
      <!-- GitHub Logo -->
      <div class="w-16 h-16 mx-auto mb-4 rounded-2xl card-raised border border-[var(--color-border)] flex items-center justify-center shadow-lg">
        <svg class="w-9 h-9 text-white fill-current" viewBox="0 0 24 24">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"></path>
        </svg>
      </div>

      <h3 class="text-lg font-bold text-[var(--color-text)] mb-1">
        {{ userStore.hasAccount ? '切换 GitHub 账号' : '欢迎来到 HappyGit' }}
      </h3>
      <p class="text-xs text-[var(--color-text-muted)] mb-5 leading-relaxed">
        {{ userStore.hasAccount ? '在 GitHub 网页确认授权后切换账号' : '登录后可同步公开仓库与 Star，生成技术兴趣画像并记录本机浏览历史' }}
      </p>

      <!-- 阶段 1: 待发起或初始状态 -->
      <div v-if="userStore.authStage === 'idle'">
        <!-- 错误提示 -->
        <div v-if="userStore.authError" class="mb-4 p-3 rounded-xl bg-red-950/40 border border-[var(--color-danger)] text-xs text-[var(--color-danger)] text-left selectable">
          {{ userStore.authError }}
        </div>

        <button
          @click="startLoginFlow"
          class="w-full btn-primary mb-3 shadow-lg cursor-pointer"
        >
          <span>使用 GitHub 登录</span>
        </button>

        <button
          v-if="!userStore.hasAccount"
          @click="handleSkip"
          class="w-full btn-secondary text-xs cursor-pointer"
        >
          <span>跳过登录，以游客身份浏览 ➔</span>
        </button>
        <button
          v-else
          @click="handleCancelSwitch"
          class="w-full btn-secondary text-xs cursor-pointer"
        >
          <span>取消切换</span>
        </button>
      </div>

      <!-- 阶段 2: 正在打开授权页 -->
      <div v-else-if="userStore.authStage === 'requesting'" class="py-6 flex flex-col items-center">
        <div class="w-8 h-8 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin mb-3"></div>
        <p class="text-xs text-[var(--color-text-muted)]">正在打开 GitHub 授权页...</p>
      </div>

      <!-- 阶段 3: 等待用户在浏览器验证 -->
      <div v-else-if="userStore.authStage === 'waiting' && challenge" class="space-y-4">
        <div class="p-4 rounded-xl card-raised border border-[var(--color-border)] text-left">
          <p class="text-sm text-[var(--color-text)]">请在浏览器中完成 GitHub 授权</p>
          <p class="mt-2 text-xs text-[var(--color-text-muted)] leading-relaxed">确认授权后会自动登录，可随时返回此窗口查看结果。</p>
          <p v-if="userStore.authError" class="mt-2 text-xs text-[var(--color-danger)]">{{ userStore.authError }}</p>
        </div>

        <button
          @click="openAuthUrl"
          class="w-full btn-primary cursor-pointer flex items-center justify-center gap-1.5"
        >
          <span>重新打开 GitHub 授权页 ↗</span>
        </button>

        <div class="flex items-center justify-center gap-2 text-xs text-[var(--color-text-subtle)]">
          <div class="w-3.5 h-3.5 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin"></div>
          <span>等待浏览器授权确认中...</span>
        </div>

        <button
          @click="cancelAuth"
          class="w-full py-2 text-xs text-[var(--color-text-subtle)] hover:text-[var(--color-text-muted)] transition cursor-pointer"
        >
          取消授权
        </button>
      </div>

      <!-- 阶段 4: 正在校验令牌与资料 -->
      <div v-else-if="userStore.authStage === 'verifying'" class="py-6 flex flex-col items-center">
        <div class="w-8 h-8 border-2 border-[var(--color-success)] border-t-transparent rounded-full animate-spin mb-3"></div>
        <p class="text-xs text-[var(--color-success)]">授权成功！正在加载账号数据...</p>
      </div>

      <!-- 隐私与存储说明 -->
      <div class="mt-5 p-3 rounded-xl card-surface border border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] leading-relaxed text-left">
        <p class="text-[var(--color-text)] font-medium mb-0.5">ℹ️ 数据与存储说明：</p>
        <p>
          {{ userStore.hasAccount
            ? 'GitHub 个人公开资料与公开仓库将保存在本机；浏览历史仅保存在当前设备，不会上传。'
            : '可以浏览公开热门项目；游客模式不保存账号资料和个人浏览历史。' }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useUserStore } from '../stores/user'
import { nativeBridge } from '../platform'

const props = defineProps({
  isOpen: Boolean
})

const emit = defineEmits(['close', 'skip'])
const userStore = useUserStore()

const challenge = computed(() => userStore.loginChallenge)

const startLoginFlow = async () => {
  try {
    await userStore.startLogin()
  } catch {
    // 错误在 store.authError 中呈现
  }
}

const openAuthUrl = async () => {
  const url = challenge.value?.authorizationUrl
  const result = await nativeBridge.invoke('external.open', { url })
  if (!result.ok) userStore.authError = result.error?.message || '无法打开浏览器'
}

const cancelAuth = async () => {
  await userStore.cancelLogin()
}

const handleSkip = async () => {
  await userStore.handleSkipLogin()
  emit('skip')
  emit('close')
}

const handleCancelSwitch = () => {
  userStore.cancelLogin()
  emit('close')
}
</script>

<template>
  <AppDialog :is-open="isOpen" :label="userStore.hasAccount ? '切换 GitHub 账号' : '连接 GitHub'" class="login-dialog" @close="close">
    <div class="p-6 sm:p-7 text-center">
      <div class="w-16 h-16 mx-auto mb-5 rounded-2xl card-raised flex items-center justify-center">
        <svg class="w-9 h-9 text-[var(--color-text)] fill-current" viewBox="0 0 24 24" aria-hidden="true">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"></path>
        </svg>
      </div>

      <h2 class="dialog-title mb-2">{{ userStore.hasAccount ? '切换 GitHub 账号' : '欢迎来到 HappyGit' }}</h2>
      <p class="text-[0.875rem] text-[var(--color-text-muted)] mb-6 leading-relaxed">连接 GitHub，发现你的项目与 Star。浏览历史保存在当前设备。</p>

      <div v-if="userStore.authStage === 'idle'">
        <p v-if="userStore.authError" role="alert" class="mb-4 p-4 rounded-xl border border-[var(--color-danger)] text-[0.875rem] leading-relaxed text-[var(--color-danger)] text-left selectable">
          {{ userStore.authError }}
        </p>
        <button type="button" class="w-full btn-primary mb-3" @click="startLogin">使用 GitHub 登录</button>
        <button v-if="!userStore.hasAccount" type="button" class="w-full btn-secondary" @click="handleSkip">暂时浏览</button>
        <button v-else type="button" class="w-full btn-secondary" @click="close">取消切换</button>
      </div>

      <div v-else-if="userStore.authStage === 'opening' || userStore.authStage === 'waiting'" class="space-y-4">
        <div class="p-4 rounded-2xl card-raised text-left">
          <p class="text-[0.9375rem] font-semibold text-[var(--color-text)]">请在 GitHub 页面完成登录</p>
          <p class="mt-2 text-[0.875rem] text-[var(--color-text-muted)] leading-relaxed">应用已打开 GitHub 官方登录页面。完成登录或二次验证后，将自动返回 HappyGit。</p>
          <p v-if="userStore.authError" role="alert" class="mt-2 text-[0.875rem] leading-relaxed text-[var(--color-danger)]">{{ userStore.authError }}</p>
        </div>
        <p role="status" class="flex items-center justify-center gap-2 text-[0.875rem] text-[var(--color-text-muted)]">
          <LoaderCircle :size="18" class="animate-spin shrink-0" aria-hidden="true" />
          等待网页登录完成…
        </p>
        <button type="button" class="w-full btn-secondary" @click="startLogin">返回登录窗口</button>
        <button type="button" class="w-full btn-secondary" @click="cancelLogin">取消登录</button>
      </div>

      <div v-else-if="userStore.authStage === 'verifying'" role="status" class="py-6 flex flex-col items-center gap-3">
        <LoaderCircle :size="28" class="animate-spin text-[var(--color-primary)]" aria-hidden="true" />
        <p class="text-[0.875rem] leading-relaxed text-[var(--color-text-muted)]">登录成功，正在同步公开资料…</p>
      </div>

      <div class="mt-6 p-4 rounded-2xl card-raised text-[0.8125rem] text-[var(--color-text-muted)] leading-relaxed text-left">
        <p class="text-[var(--color-text)] font-semibold mb-2 flex items-center gap-2">
          <ShieldCheck :size="17" class="shrink-0" aria-hidden="true" />
          隐私与存储
        </p>
        <p>网页会话、公开仓库和 Star 保留在当前设备。密码、Token 和浏览历史不会上传到项目服务器。</p>
      </div>
    </div>
  </AppDialog>
</template>

<script setup>
import { computed } from 'vue'
import { LoaderCircle, ShieldCheck } from 'lucide-vue-next'
import AppDialog from './AppDialog.vue'
import { useUserStore } from '../stores/user'

const props = defineProps({
  modelValue: {
    type: Boolean,
    default: undefined
  },
  isOpen: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:modelValue', 'close', 'logged-in'])

const userStore = useUserStore()

const isOpen = computed({
  get: () => (props.modelValue !== undefined ? props.modelValue : props.isOpen),
  set: (val) => {
    emit('update:modelValue', val)
    if (!val) emit('close')
  }
})

function close() {
  isOpen.value = false
}

async function startLogin() {
  try {
    const intent = userStore.hasAccount ? 'switch' : 'login'
    await userStore.startLogin(intent)
  } catch (_) {}
}

async function cancelLogin() {
  await userStore.cancelLogin()
}

function handleSkip() {
  userStore.handleSkipLogin()
  close()
}
</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fade-in">
    <div class="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-2xl relative text-center">
      <!-- GitHub Logo -->
      <div class="w-16 h-16 mx-auto mb-4 rounded-2xl bg-zinc-800 border border-zinc-700/60 flex items-center justify-center shadow-lg">
        <svg class="w-10 h-10 text-white fill-current" viewBox="0 0 24 24">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"></path>
        </svg>
      </div>

      <h3 class="text-xl font-bold text-white mb-1">欢迎来到 HappyGit</h3>
      <p class="text-xs text-zinc-400 mb-5 leading-relaxed">
        使用 GitHub 账号登录可同步公开开源项目，享受专属推荐画像与历史记录
      </p>

      <!-- Input GitHub Username -->
      <div class="mb-4 text-left">
        <label class="block text-xs font-semibold text-zinc-400 mb-1.5">GitHub 用户名</label>
        <input
          v-model="username"
          type="text"
          class="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-rose-500 transition"
          placeholder="例如: FanFenMo"
          @keyup.enter="handleLogin"
        />
      </div>

      <!-- Action Button 1: Login -->
      <button
        @click="handleLogin"
        :disabled="loading"
        class="w-full py-3 rounded-xl font-medium text-sm text-white bg-gradient-to-r from-rose-500 to-amber-500 shadow-lg shadow-rose-500/20 hover:opacity-90 active:scale-98 transition flex items-center justify-center gap-2 mb-3"
      >
        <span v-if="loading" class="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin"></span>
        <span>{{ loading ? '正在连接 GitHub...' : '立即登录 GitHub' }}</span>
      </button>

      <!-- Action Button 2: Skip Login (Guest Mode) -->
      <button
        @click="handleSkip"
        class="w-full py-2.5 rounded-xl font-medium text-xs text-zinc-400 hover:text-white bg-zinc-800/80 hover:bg-zinc-800 border border-zinc-700/60 transition flex items-center justify-center gap-1.5 active:scale-98"
      >
        <span>跳过登录，以游客身份浏览 ➔</span>
      </button>

      <!-- Notice -->
      <div class="mt-4 p-2.5 rounded-xl bg-zinc-950/70 border border-zinc-800/80 text-[11px] text-zinc-500 leading-normal text-left">
        <p class="text-zinc-400 font-medium mb-0.5">ℹ️ 游客模式提示：</p>
        <p>可自由浏览 3 个月内热门开源项目。系统不会收集个人信息，且不提供个人多维画像、项目收藏与浏览历史记录。</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  isOpen: Boolean
})

const emit = defineEmits(['login', 'skip'])

const username = ref('FanFenMo')
const loading = ref(false)

const handleLogin = async () => {
  if (!username.value.trim()) return
  loading.value = true
  try {
    await emit('login', username.value.trim())
  } finally {
    loading.value = false
  }
}

const handleSkip = () => {
  emit('skip')
}
</script>
